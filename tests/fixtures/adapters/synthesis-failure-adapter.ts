import type { DomainAdapter } from "../../../src/types";

const adapter: DomainAdapter = {
  id: "synthesis-failure",
  name: "Synthesis Failure Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "speaker",
      name: "Speaker",
      role: "speaker",
      persona: "Pragmatic",
      systemPrompt: "Discuss clearly.",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "synth",
      name: "Synth",
      role: "synthesiser",
      persona: "Summariser",
      systemPrompt: "Synthesize."
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
          turnOrder: ["speaker"]
        }
      ]
    }
  ]
};

export default adapter;
