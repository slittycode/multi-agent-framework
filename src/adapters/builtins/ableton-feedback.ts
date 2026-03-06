import { DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD } from "../../core/actionability";
import type { DomainAdapter } from "../../types";

const abletonFeedback: DomainAdapter = {
  id: "ableton-feedback",
  name: "Ableton Feedback Session",
  version: "1.0.0",
  description: "Multi-perspective production feedback for tracks and arrangements.",
  synthesisAgentId: "producer-synthesiser",
  agents: [
    {
      id: "technical-critic",
      name: "Technical Critic",
      role: "mix-arrangement-critic",
      persona: "Detail-driven engineer focused on mix, sound design, and arrangement execution.",
      systemPrompt:
        "Critique gain staging, frequency balance, dynamics, stereo field, arrangement flow, and technical polish.",
      objective: "Improve technical quality and translation across playback systems.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "emotional-listener",
      name: "Emotional Listener",
      role: "experience-critic",
      persona: "Audience-first listener focused on feeling, tension, and narrative arc.",
      systemPrompt:
        "Evaluate emotional payoff, groove, momentum, and whether moments feel compelling to a listener.",
      objective: "Increase emotional engagement and memorability.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    },
    {
      id: "producer-synthesiser",
      name: "Producer Synthesiser",
      role: "production-synthesiser",
      persona: "Senior producer balancing artistry with execution feasibility.",
      systemPrompt:
        "Merge technical and emotional critique into a practical production plan with high-impact priorities.",
      objective: "Deliver a focused set of next actions for session iteration.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash"
      }
    }
  ],
  rounds: [
    {
      id: "feedback-round",
      name: "Track Feedback Round",
      description: "Opening analysis, cross-perspective challenge, and rebuttal refinement.",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Each agent gives initial track feedback from its perspective.",
          turnOrder: ["technical-critic", "emotional-listener"]
        },
        {
          id: "challenge",
          name: "Challenge",
          instructions:
            "Agents challenge each other's framing and identify missing production risks or opportunities.",
          turnOrder: ["emotional-listener", "technical-critic"]
        },
        {
          id: "rebuttal",
          name: "Rebuttal",
          instructions: "Agents finalize refined guidance and trade-off-aware recommendations.",
          turnOrder: ["technical-critic", "emotional-listener"]
        }
      ]
    }
  ],
  orchestrator: {
    phaseJudge: {
      enabled: true,
      cadence: "after_each_phase",
      agentId: "producer-synthesiser"
    },
    qualityGate: {
      enabled: true,
      threshold: DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD
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
    runIntro:
      "Evaluate the track like a focused production review: concrete observations, specific improvements, no vague praise.",
    synthesisInstructions:
      "Produce a prioritized production action list with expected impact and suggested order of operations."
  }
};

export default abletonFeedback;
