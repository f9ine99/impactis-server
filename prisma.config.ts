import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

// Load the same env file the Nest app uses for local development.
dotenv.config({ path: ".env.local" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});


