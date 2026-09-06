import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakeSession, fakeTransport, reply, toolCall } from "./fakeTransport.mjs";

const settle = () => new Promise((r) => setTimeout(r, 5));

/**
 * The protocol, driven end to end with no network.
 *
 * Everything here was previously asserted by grepping the source for a line
 * that looked right. These say what the server sent and check what the client
 * sent back.
 */
describe("asking for a response", () => {
  test("a turn ending is answered exactly once", async () => {
    // We set create_response: false, so the server commits the turn and
    // generates nothing. A turn this fails to answer is silence: no error, no
    // timeout, no retry from the server.
    const { transport } = await fakeSession();
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    assert.equal(transport.ofType("response.create").length, 1);
  });

  test("a second turn arriving mid-response is deferred, not dropped", async () => {
    // Asking for two at once is conversation_already_has_active_response,
    // which arrives as an async error and drops the request -- so the turn
    // that prompted it gets no answer at all, in any medium. Observed live:
    // 14 of 25 turns went unanswered.
    const { transport, events } = await fakeSession();
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server({ type: "response.created" });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();

    assert.equal(transport.ofType("response.create").length, 1, "a second request went out while one was live");
    assert.ok(events.some((e) => e.type === "response_deferred"));
  });

  test("and the deferred one is asked for when the first finishes", async () => {
    const { transport } = await fakeSession();
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server({ type: "response.created" });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(reply("Done."));
    await settle();
    assert.equal(transport.ofType("response.create").length, 2, "the deferred turn was never answered");
  });
});

describe("choosing the medium", () => {
  const modalityOf = (transport, index = 0) =>
    transport.ofType("response.create")[index].response.output_modalities[0];

  test("a command is answered in text, a question aloud", async () => {
    const { session, transport } = await fakeSession();
    session.sendTextTurn("go to settings");
    await settle();
    assert.equal(modalityOf(transport), "text");

    // The first response has to FINISH before the next turn is asked for --
    // otherwise it is deferred, which is the serialisation working.
    transport.server(reply("Done."));
    await settle();
    session.sendTextTurn("how many tasks are there?");
    await settle();
    assert.equal(modalityOf(transport, 1), "audio");
  });

  test("answer_aloud overrides the transcript, for the reply after the tool", async () => {
    // The model knows what it is ABOUT to say; the transcript only hints at
    // what was asked. "And the other one?" is hopeless from phrasing.
    const { transport } = await fakeSession();
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("answer_aloud", { because: "a count was asked for" }));
    await settle();
    const requests = transport.ofType("response.create");
    assert.equal(requests.at(-1).response.output_modalities[0], "audio");
  });

  test("a typed turn does not inherit the last spoken turn's flag", async () => {
    // Observed live: "Opened settings." came back as audio on turns the model
    // never flagged, because answer_aloud stayed set from a question before.
    const { session, transport } = await fakeSession();
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("answer_aloud", { because: "x" }));
    await settle();
    transport.server(reply("There are three.", ["audio"]));
    await settle();

    session.sendTextTurn("go to settings");
    await settle();
    assert.equal(transport.ofType("response.create").at(-1).response.output_modalities[0], "text");
  });
});

describe("tool calls", () => {
  test("the result goes back and a follow-up is requested", async () => {
    const calls = [];
    const { transport } = await fakeSession({
      onToolCall: async (name, args) => {
        calls.push({ name, args });
        return { status: "navigated" };
      },
    });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("navigate", { path: "/settings" }));
    await settle();

    assert.deepEqual(calls, [{ name: "navigate", args: { path: "/settings" } }]);
    const output = transport.ofType("conversation.item.create").at(-1);
    assert.equal(output.item.type, "function_call_output");
    assert.deepEqual(JSON.parse(output.item.output), { status: "navigated" });
    assert.equal(transport.ofType("response.create").length, 2, "the reply after the tool was never asked for");
  });

  test("a tool that throws reports the error rather than stalling the turn", async () => {
    const { transport } = await fakeSession({ onToolCall: async () => { throw new Error("no such route"); } });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("navigate", { path: "/nope" }));
    await settle();
    const output = JSON.parse(transport.ofType("conversation.item.create").at(-1).item.output);
    assert.match(output.error, /no such route/);
    assert.equal(transport.ofType("response.create").length, 2);
  });

  test("the agent counts as busy for the whole turn, not just while generating", async () => {
    // response.done clears the busy flag, and that is exactly when the model
    // finishes ASKING for a tool. A user watched the rim say "ready to listen"
    // through every tool call of a four-minute session.
    const states = [];
    const { transport } = await fakeSession({
      onActivity: (a) => states.push(a.agentBusy),
      onToolCall: async () => {
        // Busy must be true at the moment a tool is actually running.
        states.push("during-tool");
        return {};
      },
    });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("dom_snapshot"));
    await settle();

    const duringTool = states.indexOf("during-tool");
    assert.ok(duringTool > 0, "the tool never ran");
    assert.ok(!states.slice(0, duringTool).includes(false) || states[duringTool - 1] !== false,
      `the rim went idle before the tool ran: ${JSON.stringify(states)}`);
  });
});

describe("hanging up", () => {
  test("the goodbye is spoken before the microphone is released", async () => {
    // end_session arrives INSIDE a response, and the farewell is a second
    // response generated after the tool result goes back. Acting where the
    // call lands cuts off the goodbye the same rule asked for.
    const hangUps = [];
    const { transport } = await fakeSession({ onHangUp: (info) => hangUps.push(info) });
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    transport.server(toolCall("end_session", { because: "that's all for now" }));
    await settle();
    assert.deepEqual(hangUps, [], "hung up before saying goodbye");

    transport.server({ type: "response.created" });
    transport.server({ type: "output_audio_buffer.started" });
    transport.server(reply("Goodbye.", ["audio"]));
    await settle();
    assert.deepEqual(hangUps, [], "hung up while the goodbye was still playing");

    transport.server({ type: "output_audio_buffer.stopped" });
    await settle();
    assert.equal(hangUps.length, 1);
    assert.equal(hangUps[0].because, "that's all for now");
  });

  test("a written goodbye hangs up without waiting for audio that never comes", async () => {
    const hangUps = [];
    const { session, transport } = await fakeSession({ onHangUp: (i) => hangUps.push(i) });
    session.sendTextTurn("thanks, that's all");
    await settle();
    transport.server(toolCall("end_session", { because: "thanks, that's all" }));
    await settle();
    transport.server(reply("Goodbye."));
    await settle();
    assert.equal(hangUps.length, 1);
  });
});

describe("push to talk", () => {
  test("turn detection is switched off, with create_response repeated", async () => {
    // A bare { type: "server_vad" } resets create_response to its default of
    // true, handing response creation quietly back to the server.
    const { session, transport } = await fakeSession({ initialMode: "ptt" });
    const patch = transport.ofType("session.update").at(-1);
    assert.equal(patch.session.type, "realtime", "the API rejects the patch without this, silently");
    assert.equal(patch.session.audio.input.turn_detection, null);

    session.setTurnDetection(true);
    const back = transport.ofType("session.update").at(-1);
    assert.deepEqual(back.session.audio.input.turn_detection, { type: "server_vad", create_response: false });
  });

  test("the button ends the turn, and the server's commit does not answer it twice", async () => {
    const { session, transport } = await fakeSession({ initialMode: "ptt" });
    session.commitAndRespond();
    await settle();
    assert.equal(transport.ofType("input_audio_buffer.commit").length, 1);
    assert.equal(transport.ofType("response.create").length, 1);

    // In ptt the server's own commit must NOT trigger a second response.
    transport.server({ type: "input_audio_buffer.committed" });
    await settle();
    assert.equal(transport.ofType("response.create").length, 1, "the turn was answered twice");
  });
});
