import type { DomainAdapter } from "../types";

export type AdapterValidationErrorCode =
  | "INVALID_ADAPTER_TYPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE"
  | "DUPLICATE_AGENT_ID"
  | "UNKNOWN_SYNTHESIS_AGENT"
  | "INVALID_ORCHESTRATOR_EXECUTION_MODE"
  | "INVALID_CONTEXT_POLICY"
  | "INVALID_PHASE_JUDGE_CONFIG"
  | "INVALID_QUALITY_GATE"
  | "INVALID_CITATION_CONFIG"
  | "INVALID_PHASE_EXECUTION_MODE"
  | "INVALID_VISIBILITY_POLICY"
  | "UNKNOWN_VISIBILITY_PARTICIPANT"
  | "UNKNOWN_JUDGE_AGENT"
  | "UNKNOWN_PHASE_JUDGE_AGENT"
  | "EMPTY_TURN_ORDER"
  | "UNKNOWN_TURN_ORDER_AGENT";

export interface AdapterValidationError {
  code: AdapterValidationErrorCode;
  path: string;
  message: string;
  value?: unknown;
}

export interface AdapterValidationResult {
  valid: boolean;
  errors: AdapterValidationError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateDomainAdapter(candidate: unknown): AdapterValidationResult {
  const errors: AdapterValidationError[] = [];

  if (!isRecord(candidate)) {
    return {
      valid: false,
      errors: [
        {
          code: "INVALID_ADAPTER_TYPE",
          path: "$",
          message: "Adapter must be a non-null object.",
          value: candidate
        }
      ]
    };
  }

  const requiredFields = ["id", "name", "version", "agents", "rounds", "synthesisAgentId"] as const;
  for (const field of requiredFields) {
    if (!(field in candidate)) {
      errors.push({
        code: "MISSING_REQUIRED_FIELD",
        path: `$.${field}`,
        message: `Missing required field "${field}".`
      });
    }
  }

  const id = candidate.id;
  const name = candidate.name;
  const version = candidate.version;
  const synthesisAgentId = candidate.synthesisAgentId;
  const agents = candidate.agents;
  const rounds = candidate.rounds;

  if (!isNonEmptyString(id)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.id",
      message: 'Field "id" must be a non-empty string.',
      value: id
    });
  }

  if (!isNonEmptyString(name)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.name",
      message: 'Field "name" must be a non-empty string.',
      value: name
    });
  }

  if (!isNonEmptyString(version)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.version",
      message: 'Field "version" must be a non-empty string.',
      value: version
    });
  }

  if (!isNonEmptyString(synthesisAgentId)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.synthesisAgentId",
      message: 'Field "synthesisAgentId" must be a non-empty string.',
      value: synthesisAgentId
    });
  }

  const knownAgentIds = new Set<string>();

  if (!Array.isArray(agents)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.agents",
      message: 'Field "agents" must be an array.',
      value: agents
    });
  } else {
    for (let agentIndex = 0; agentIndex < agents.length; agentIndex += 1) {
      const agent = agents[agentIndex];
      if (!isRecord(agent)) {
        errors.push({
          code: "INVALID_FIELD_TYPE",
          path: `$.agents[${agentIndex}]`,
          message: "Each agent must be an object.",
          value: agent
        });
        continue;
      }

      const agentId = agent.id;
      if (!isNonEmptyString(agentId)) {
        errors.push({
          code: "INVALID_FIELD_TYPE",
          path: `$.agents[${agentIndex}].id`,
          message: 'Each agent.id must be a non-empty string.',
          value: agentId
        });
        continue;
      }

      if (knownAgentIds.has(agentId)) {
        errors.push({
          code: "DUPLICATE_AGENT_ID",
          path: `$.agents[${agentIndex}].id`,
          message: `Duplicate agent id "${agentId}".`,
          value: agentId
        });
        continue;
      }

      knownAgentIds.add(agentId);
    }
  }

  if (isNonEmptyString(synthesisAgentId) && !knownAgentIds.has(synthesisAgentId)) {
    errors.push({
      code: "UNKNOWN_SYNTHESIS_AGENT",
      path: "$.synthesisAgentId",
      message: `synthesisAgentId "${synthesisAgentId}" does not reference an agent in agents[].`,
      value: synthesisAgentId
    });
  }

  if (!Array.isArray(rounds)) {
    errors.push({
      code: "INVALID_FIELD_TYPE",
      path: "$.rounds",
      message: 'Field "rounds" must be an array.',
      value: rounds
    });
  } else {
    for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
      const round = rounds[roundIndex];
      if (!isRecord(round)) {
        errors.push({
          code: "INVALID_FIELD_TYPE",
          path: `$.rounds[${roundIndex}]`,
          message: "Each round must be an object.",
          value: round
        });
        continue;
      }

      const phases = round.phases;
      if (!Array.isArray(phases)) {
        errors.push({
          code: "INVALID_FIELD_TYPE",
          path: `$.rounds[${roundIndex}].phases`,
          message: "Each round must include a phases array.",
          value: phases
        });
        continue;
      }

      for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
        const phase = phases[phaseIndex];
        if (!isRecord(phase)) {
          errors.push({
            code: "INVALID_FIELD_TYPE",
            path: `$.rounds[${roundIndex}].phases[${phaseIndex}]`,
            message: "Each phase must be an object.",
            value: phase
          });
          continue;
        }

        const turnOrder = phase.turnOrder;
        const turnOrderPath = `$.rounds[${roundIndex}].phases[${phaseIndex}].turnOrder`;
        if (!Array.isArray(turnOrder)) {
          errors.push({
            code: "INVALID_FIELD_TYPE",
            path: turnOrderPath,
            message: "turnOrder must be an array of agent ids.",
            value: turnOrder
          });
          continue;
        }

        if (turnOrder.length < 1) {
          errors.push({
            code: "EMPTY_TURN_ORDER",
            path: turnOrderPath,
            message: "turnOrder must contain at least one agent id.",
            value: turnOrder
          });
          continue;
        }

        for (let orderIndex = 0; orderIndex < turnOrder.length; orderIndex += 1) {
          const turnAgentId = turnOrder[orderIndex];
          const turnPath = `${turnOrderPath}[${orderIndex}]`;
          if (!isNonEmptyString(turnAgentId)) {
            errors.push({
              code: "INVALID_FIELD_TYPE",
              path: turnPath,
              message: "turnOrder entries must be non-empty strings.",
              value: turnAgentId
            });
            continue;
          }

          if (!knownAgentIds.has(turnAgentId)) {
            errors.push({
              code: "UNKNOWN_TURN_ORDER_AGENT",
              path: turnPath,
              message: `turnOrder references unknown agent id "${turnAgentId}".`,
              value: turnAgentId
            });
          }
        }

        const executionMode = phase.executionMode;
        if (
          executionMode !== undefined &&
          executionMode !== "sequential" &&
          executionMode !== "fanout"
        ) {
          errors.push({
            code: "INVALID_PHASE_EXECUTION_MODE",
            path: `$.rounds[${roundIndex}].phases[${phaseIndex}].executionMode`,
            message: 'executionMode must be "sequential" or "fanout".',
            value: executionMode
          });
        }

        const visibilityPolicy = phase.visibilityPolicy;
        const visibilityPolicyPath = `$.rounds[${roundIndex}].phases[${phaseIndex}].visibilityPolicy`;
        if (visibilityPolicy !== undefined) {
          if (!isRecord(visibilityPolicy)) {
            errors.push({
              code: "INVALID_VISIBILITY_POLICY",
              path: visibilityPolicyPath,
              message: "visibilityPolicy must be an object.",
              value: visibilityPolicy
            });
          } else {
            const participants = visibilityPolicy.participants;
            if (!Array.isArray(participants) || participants.length < 1) {
              errors.push({
                code: "INVALID_VISIBILITY_POLICY",
                path: `${visibilityPolicyPath}.participants`,
                message: "visibilityPolicy.participants must be a non-empty array of agent ids.",
                value: participants
              });
            } else {
              for (let participantIndex = 0; participantIndex < participants.length; participantIndex += 1) {
                const participant = participants[participantIndex];
                const participantPath = `${visibilityPolicyPath}.participants[${participantIndex}]`;
                if (!isNonEmptyString(participant)) {
                  errors.push({
                    code: "INVALID_VISIBILITY_POLICY",
                    path: participantPath,
                    message: "visibilityPolicy participants must be non-empty strings.",
                    value: participant
                  });
                  continue;
                }

                if (!knownAgentIds.has(participant)) {
                  errors.push({
                    code: "UNKNOWN_VISIBILITY_PARTICIPANT",
                    path: participantPath,
                    message: `visibilityPolicy references unknown agent id "${participant}".`,
                    value: participant
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const orchestrator = candidate.orchestrator;
  if (orchestrator !== undefined) {
    if (!isRecord(orchestrator)) {
      errors.push({
        code: "INVALID_FIELD_TYPE",
        path: "$.orchestrator",
        message: 'Field "orchestrator" must be an object when provided.',
        value: orchestrator
      });
    } else {
      const executionMode = orchestrator.executionMode;
      if (
        executionMode !== undefined &&
        executionMode !== "sequential" &&
        executionMode !== "parallel"
      ) {
        errors.push({
          code: "INVALID_ORCHESTRATOR_EXECUTION_MODE",
          path: "$.orchestrator.executionMode",
          message: 'orchestrator.executionMode must be "sequential" or "parallel".',
          value: executionMode
        });
      }

      const judge = orchestrator.judge;
      if (judge !== undefined) {
        if (!isRecord(judge)) {
          errors.push({
            code: "INVALID_FIELD_TYPE",
            path: "$.orchestrator.judge",
            message: 'Field "orchestrator.judge" must be an object when provided.',
            value: judge
          });
        } else {
          const judgeAgentId = judge.agentId;
          if (!isNonEmptyString(judgeAgentId)) {
            errors.push({
              code: "INVALID_FIELD_TYPE",
              path: "$.orchestrator.judge.agentId",
              message: 'Field "orchestrator.judge.agentId" must be a non-empty string.',
              value: judgeAgentId
            });
          } else if (!knownAgentIds.has(judgeAgentId)) {
            errors.push({
              code: "UNKNOWN_JUDGE_AGENT",
              path: "$.orchestrator.judge.agentId",
              message: `orchestrator.judge.agentId "${judgeAgentId}" does not reference an agent in agents[].`,
              value: judgeAgentId
            });
          }
        }
      }

      const phaseJudge = orchestrator.phaseJudge;
      if (phaseJudge !== undefined) {
        if (!isRecord(phaseJudge)) {
          errors.push({
            code: "INVALID_PHASE_JUDGE_CONFIG",
            path: "$.orchestrator.phaseJudge",
            message: 'Field "orchestrator.phaseJudge" must be an object when provided.',
            value: phaseJudge
          });
        } else {
          const phaseJudgeEnabled = phaseJudge.enabled;
          if (phaseJudgeEnabled !== undefined && !isBoolean(phaseJudgeEnabled)) {
            errors.push({
              code: "INVALID_PHASE_JUDGE_CONFIG",
              path: "$.orchestrator.phaseJudge.enabled",
              message: 'Field "orchestrator.phaseJudge.enabled" must be a boolean when provided.',
              value: phaseJudgeEnabled
            });
          }

          const phaseJudgeCadence = phaseJudge.cadence;
          if (phaseJudgeCadence !== undefined && phaseJudgeCadence !== "after_each_phase") {
            errors.push({
              code: "INVALID_PHASE_JUDGE_CONFIG",
              path: "$.orchestrator.phaseJudge.cadence",
              message:
                'Field "orchestrator.phaseJudge.cadence" must be "after_each_phase" when provided.',
              value: phaseJudgeCadence
            });
          }

          const phaseJudgeAgentId = phaseJudge.agentId;
          if (!isNonEmptyString(phaseJudgeAgentId)) {
            errors.push({
              code: "INVALID_PHASE_JUDGE_CONFIG",
              path: "$.orchestrator.phaseJudge.agentId",
              message: 'Field "orchestrator.phaseJudge.agentId" must be a non-empty string.',
              value: phaseJudgeAgentId
            });
          } else if (!knownAgentIds.has(phaseJudgeAgentId)) {
            errors.push({
              code: "UNKNOWN_PHASE_JUDGE_AGENT",
              path: "$.orchestrator.phaseJudge.agentId",
              message: `orchestrator.phaseJudge.agentId "${phaseJudgeAgentId}" does not reference an agent in agents[].`,
              value: phaseJudgeAgentId
            });
          }

          const phaseJudgePromptTemplate = phaseJudge.promptTemplate;
          if (
            phaseJudgePromptTemplate !== undefined &&
            typeof phaseJudgePromptTemplate !== "string"
          ) {
            errors.push({
              code: "INVALID_PHASE_JUDGE_CONFIG",
              path: "$.orchestrator.phaseJudge.promptTemplate",
              message:
                'Field "orchestrator.phaseJudge.promptTemplate" must be a string when provided.',
              value: phaseJudgePromptTemplate
            });
          }
        }
      }

      const contextPolicy = orchestrator.contextPolicy;
      if (contextPolicy !== undefined) {
        if (!isRecord(contextPolicy)) {
          errors.push({
            code: "INVALID_CONTEXT_POLICY",
            path: "$.orchestrator.contextPolicy",
            message: 'Field "orchestrator.contextPolicy" must be an object when provided.',
            value: contextPolicy
          });
        } else {
          const contextMode = contextPolicy.mode;
          if (
            contextMode !== undefined &&
            contextMode !== "full" &&
            contextMode !== "round_plus_recent"
          ) {
            errors.push({
              code: "INVALID_CONTEXT_POLICY",
              path: "$.orchestrator.contextPolicy.mode",
              message:
                'Field "orchestrator.contextPolicy.mode" must be "full" or "round_plus_recent" when provided.',
              value: contextMode
            });
          }

          const recentMessageCount = contextPolicy.recentMessageCount;
          if (
            recentMessageCount !== undefined &&
            (!isFiniteNumber(recentMessageCount) || recentMessageCount < 1)
          ) {
            errors.push({
              code: "INVALID_CONTEXT_POLICY",
              path: "$.orchestrator.contextPolicy.recentMessageCount",
              message:
                'Field "orchestrator.contextPolicy.recentMessageCount" must be a number >= 1 when provided.',
              value: recentMessageCount
            });
          }

          const includePhaseSummaries = contextPolicy.includePhaseSummaries;
          if (includePhaseSummaries !== undefined && !isBoolean(includePhaseSummaries)) {
            errors.push({
              code: "INVALID_CONTEXT_POLICY",
              path: "$.orchestrator.contextPolicy.includePhaseSummaries",
              message:
                'Field "orchestrator.contextPolicy.includePhaseSummaries" must be a boolean when provided.',
              value: includePhaseSummaries
            });
          }
        }
      }

      const qualityGate = orchestrator.qualityGate;
      if (qualityGate !== undefined) {
        if (!isRecord(qualityGate)) {
          errors.push({
            code: "INVALID_QUALITY_GATE",
            path: "$.orchestrator.qualityGate",
            message: 'Field "orchestrator.qualityGate" must be an object when provided.',
            value: qualityGate
          });
        } else {
          const qualityGateEnabled = qualityGate.enabled;
          if (qualityGateEnabled !== undefined && !isBoolean(qualityGateEnabled)) {
            errors.push({
              code: "INVALID_QUALITY_GATE",
              path: "$.orchestrator.qualityGate.enabled",
              message: 'Field "orchestrator.qualityGate.enabled" must be a boolean when provided.',
              value: qualityGateEnabled
            });
          }

          const threshold = qualityGate.threshold;
          if (threshold !== undefined && (!isFiniteNumber(threshold) || threshold < 0 || threshold > 100)) {
            errors.push({
              code: "INVALID_QUALITY_GATE",
              path: "$.orchestrator.qualityGate.threshold",
              message:
                'Field "orchestrator.qualityGate.threshold" must be a number between 0 and 100 when provided.',
              value: threshold
            });
          }

          const recordInTranscriptMetadata = qualityGate.recordInTranscriptMetadata;
          if (recordInTranscriptMetadata !== undefined && !isBoolean(recordInTranscriptMetadata)) {
            errors.push({
              code: "INVALID_QUALITY_GATE",
              path: "$.orchestrator.qualityGate.recordInTranscriptMetadata",
              message:
                'Field "orchestrator.qualityGate.recordInTranscriptMetadata" must be a boolean when provided.',
              value: recordInTranscriptMetadata
            });
          }
        }
      }

      const citations = orchestrator.citations;
      if (citations !== undefined) {
        if (!isRecord(citations)) {
          errors.push({
            code: "INVALID_CITATION_CONFIG",
            path: "$.orchestrator.citations",
            message: 'Field "orchestrator.citations" must be an object when provided.',
            value: citations
          });
        } else {
          const mode = citations.mode;
          if (mode !== undefined && mode !== "transcript_only" && mode !== "optional_web") {
            errors.push({
              code: "INVALID_CITATION_CONFIG",
              path: "$.orchestrator.citations.mode",
              message:
                'Field "orchestrator.citations.mode" must be "transcript_only" or "optional_web" when provided.',
              value: mode
            });
          }

          const failPolicy = citations.failPolicy;
          if (
            failPolicy !== undefined &&
            failPolicy !== "graceful_fallback" &&
            failPolicy !== "fail_fast"
          ) {
            errors.push({
              code: "INVALID_CITATION_CONFIG",
              path: "$.orchestrator.citations.failPolicy",
              message:
                'Field "orchestrator.citations.failPolicy" must be "graceful_fallback" or "fail_fast" when provided.',
              value: failPolicy
            });
          }

          const maxWebSourcesPerTurn = citations.maxWebSourcesPerTurn;
          if (
            maxWebSourcesPerTurn !== undefined &&
            (!isFiniteNumber(maxWebSourcesPerTurn) || maxWebSourcesPerTurn < 1)
          ) {
            errors.push({
              code: "INVALID_CITATION_CONFIG",
              path: "$.orchestrator.citations.maxWebSourcesPerTurn",
              message:
                'Field "orchestrator.citations.maxWebSourcesPerTurn" must be a number >= 1 when provided.',
              value: maxWebSourcesPerTurn
            });
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function isDomainAdapter(candidate: unknown): candidate is DomainAdapter {
  return validateDomainAdapter(candidate).valid;
}
