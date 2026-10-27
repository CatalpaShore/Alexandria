import { z } from "zod";

export const recommendationFeedbackSchema = z.object({
  mediaId: z.string().trim().min(1).max(128),
  feedbackType: z.literal("not_interested")
});

export const recommendationFeedbackResponseSchema = recommendationFeedbackSchema.extend({
  anchorMediaId: z.string().trim().min(1).max(128),
  createdAt: z.string().datetime()
});

export const metadataQualityIssueSchema = z.object({
  type: z.enum([
    "missing_title_zh",
    "missing_actor_zh",
    "missing_genre_zh",
    "missing_cover",
    "duration_conflict",
    "future_release_date",
    "low_completeness"
  ]),
  severity: z.enum(["info", "warning", "error"]),
  details: z.record(z.string(), z.unknown()),
  detectedAt: z.string().datetime()
});

export const ingestionStageStateSchema = z.enum(["ready", "processing", "attention"]);

export const ingestionStageSchema = z.object({
  status: ingestionStageStateSchema,
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1)
});

export const ingestionCompletionSchema = z.object({
  overallStatus: ingestionStageStateSchema,
  reason: z.string(),
  stages: z.object({
    file: ingestionStageSchema,
    metadata: ingestionStageSchema,
    translation: ingestionStageSchema,
    cover: ingestionStageSchema
  })
});

export type RecommendationFeedbackInput = z.infer<typeof recommendationFeedbackSchema>;
export type RecommendationFeedbackResponse = z.infer<typeof recommendationFeedbackResponseSchema>;
export type MetadataQualityIssueContract = z.infer<typeof metadataQualityIssueSchema>;
export type IngestionCompletionContract = z.infer<typeof ingestionCompletionSchema>;
