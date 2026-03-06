import type { DomainAdapter } from "../../../src/types";

const adapter: DomainAdapter = {
  id: "fixture-ts",
  name: "Fixture TS Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "speaker",
      name: "Speaker",
      role: "speaker",
      persona: "Direct and precise",
      systemPrompt: "Provide direct analysis.",
      llm: { provider: "mock", model: "mock-model-v1" }
    },
    {
      id: "synth",
      name: "Synth",
      role: "synthesiser",
      persona: "Clear synthesis",
      systemPrompt: "Summarise outcomes.",
      llm: { provider: "mock", model: "mock-model-v1" }
    }
  ],
  rounds: [
    {
      id: "round-1",
      name: "Round One",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Open positions",
          turnOrder: ["speaker", "synth"]
        }
      ]
    }
  ]
};

export default adapter;
