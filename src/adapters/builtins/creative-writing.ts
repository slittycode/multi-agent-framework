import type { DomainAdapter } from "../../types";

const creativeWriting: DomainAdapter = {
  id: "creative-writing",
  name: "Creative Writing Workshop",
  version: "1.0.0",
  description: "Collaborative critique and development flow for narrative writing.",
  synthesisAgentId: "synthesis-writer",
  agents: [
    {
      id: "narrative-voice",
      name: "Narrative Voice",
      role: "voice-critic",
      persona: "Attentive to tone, diction, rhythm, and character perspective.",
      systemPrompt:
        "Evaluate voice consistency, emotional resonance, and language choices at sentence and paragraph level.",
      objective: "Strengthen distinct voice and emotional impact.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "structure-editor",
      name: "Structure Editor",
      role: "structure-critic",
      persona: "Architectural editor focused on pacing, arcs, and clarity.",
      systemPrompt:
        "Assess narrative structure, pacing, stakes, scene sequencing, and reader comprehension.",
      objective: "Improve story coherence and momentum.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "synthesis-writer",
      name: "Synthesis Writer",
      role: "revision-synthesiser",
      persona: "Constructive and pragmatic revision coach.",
      systemPrompt:
        "Synthesize critique into prioritized revision actions with concrete examples and rationale.",
      objective: "Produce a clear revision roadmap and suggested rewrite direction.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    }
  ],
  rounds: [
    {
      id: "workshop-round",
      name: "Workshop Round",
      description: "Opening impressions, targeted critique, and revisions.",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Each agent gives an initial assessment of the draft.",
          turnOrder: ["narrative-voice", "structure-editor"]
        },
        {
          id: "challenge",
          name: "Challenge",
          instructions:
            "Agents challenge each other's assumptions and identify conflicts in interpretation.",
          turnOrder: ["structure-editor", "narrative-voice"]
        },
        {
          id: "rebuttal",
          name: "Rebuttal",
          instructions: "Agents refine their recommendations into revision-ready guidance.",
          turnOrder: ["narrative-voice", "structure-editor"]
        }
      ]
    }
  ],
  orchestrator: {
    phaseJudge: {
      enabled: true,
      cadence: "after_each_phase",
      agentId: "synthesis-writer"
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
    runIntro: "Focus on improving the text while preserving author intent where possible.",
    synthesisInstructions:
      "Provide a concise summary and a prioritized revision list that the writer can apply immediately."
  }
};

export default creativeWriting;
