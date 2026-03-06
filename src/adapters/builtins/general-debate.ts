import type { DomainAdapter } from "../../types";

const generalDebate: DomainAdapter = {
  id: "general-debate",
  name: "General Debate",
  version: "1.0.0",
  description: "Domain-agnostic structured debate for any topic.",
  synthesisAgentId: "synthesiser",
  agents: [
    {
      id: "advocate",
      name: "Advocate",
      role: "position-advocate",
      persona: "Confident, constructive, and evidence-oriented.",
      systemPrompt:
        "Present a clear position with concrete support. Acknowledge trade-offs without abandoning the core argument.",
      objective: "Build the strongest possible case for the proposed position.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "critic",
      name: "Critic",
      role: "critical-challenger",
      persona: "Skeptical, precise, and focused on assumptions.",
      systemPrompt:
        "Identify weak assumptions, missing evidence, and risks. Prioritize substantive critique over rhetoric.",
      objective: "Stress-test the argument for logic gaps and practical risks.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "synthesiser",
      name: "Synthesiser",
      role: "synthesis-agent",
      persona: "Balanced, decision-oriented, and practical.",
      systemPrompt:
        "Integrate the strongest points from all sides. Produce a clear synthesis with actionable recommendations.",
      objective: "Deliver a final balanced outcome with clear next steps.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    }
  ],
  rounds: [
    {
      id: "main-round",
      name: "Main Debate Round",
      description: "Structured exchange through opening, challenge, and rebuttal.",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Each agent states its opening position on the topic.",
          turnOrder: ["advocate", "critic"]
        },
        {
          id: "challenge",
          name: "Challenge",
          instructions:
            "Agents challenge earlier claims and highlight assumptions, risks, and counter-arguments.",
          turnOrder: ["critic", "advocate"]
        },
        {
          id: "rebuttal",
          name: "Rebuttal",
          instructions: "Agents respond to challenges and refine their final stance.",
          turnOrder: ["advocate", "critic"]
        }
      ]
    }
  ],
  orchestrator: {
    phaseJudge: {
      enabled: true,
      cadence: "after_each_phase",
      agentId: "synthesiser"
    },
    qualityGate: {
      enabled: true,
      threshold: 75
    },
    contextPolicy: {
      mode: "round_plus_recent"
    },
    citations: {
      mode: "optional_web",
      failPolicy: "graceful_fallback"
    }
  },
  prompts: {
    runIntro: "Debate the topic rigorously while staying concrete and actionable.",
    synthesisInstructions:
      "Summarize agreement and disagreement, then provide a practical recommendation with rationale."
  }
};

export default generalDebate;
