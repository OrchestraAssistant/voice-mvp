import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSettings, useUpdateSettings } from "../api.js";

export const SettingsSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Must be a valid email"),
  theme: z.enum(["light", "dark"]),
});

export default function Settings() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(SettingsSchema) });

  useEffect(() => {
    if (settings) reset(settings);
  }, [settings, reset]);

  const onSubmit = (values) => updateSettings.mutate(values);

  return (
    <div className="page">
      <h1>Settings</h1>
      <form onSubmit={handleSubmit(onSubmit)}>
        <label htmlFor="name">Name</label>
        <input id="name" {...register("name")} />
        {errors.name && <p className="error">{errors.name.message}</p>}

        <label htmlFor="email">Email</label>
        <input id="email" type="email" {...register("email")} />
        {errors.email && <p className="error">{errors.email.message}</p>}

        <label htmlFor="theme">Theme</label>
        <select id="theme" {...register("theme")}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>

        <button type="submit" id="save-settings">
          Save Settings
        </button>
      </form>
    </div>
  );
}
