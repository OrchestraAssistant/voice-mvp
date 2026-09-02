import express from "express";
import cors from "cors";
import { api } from "./api.js";

// The demo app's OWN backend -- it stands in for a customer's existing API.
// Nothing here is part of the product; the voice relay is a separate service
// (see ../../relay) precisely so the two don't get confused again.
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", api);

app.listen(PORT, () => {
  console.log(`Demo API listening on http://localhost:${PORT}`);
});
