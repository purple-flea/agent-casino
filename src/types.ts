import type { schema } from "./db/index.js";

export type AppEnv = {
  Variables: {
    agentId: string;
    agent: typeof schema.agents.$inferSelect;
  };
};
