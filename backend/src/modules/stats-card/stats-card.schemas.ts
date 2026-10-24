import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type {
  StatsCardTheme,
  StatsCardDisplay,
} from '@maimai-score-hub/shared';
import { DEFAULT_STATS_CARD_DISPLAY } from '@maimai-score-hub/shared';

@Schema({ collection: 'stats_card_shares', timestamps: true })
export class StatsCardShare {
  @Prop({ required: true, unique: true })
  userId!: string;

  @Prop({ type: String, default: null })
  code!: string | null;

  @Prop({ default: false })
  enabled!: boolean;

  @Prop({ default: 0 })
  generation!: number;

  @Prop({
    type: {
      rating: { type: Boolean, default: true },
      awakeningCount: { type: Boolean, default: true },
      classRank: { type: Boolean, default: true },
      courseRank: { type: Boolean, default: true },
      title: { type: Boolean, default: true },
    },
    default: () => ({ ...DEFAULT_STATS_CARD_DISPLAY }),
  })
  display!: StatsCardDisplay;

  updatedAt!: Date;
}
export const StatsCardShareSchema =
  SchemaFactory.createForClass(StatsCardShare);
StatsCardShareSchema.index(
  { code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: 'string' } },
  },
);

@Schema({ collection: 'stats_card_artifacts', timestamps: true })
export class StatsCardArtifact {
  @Prop({ required: true })
  shareId!: string;

  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, enum: ['light', 'dark'] })
  theme!: StatsCardTheme;

  @Prop({ required: true })
  generation!: number;

  @Prop({ required: true })
  contentHash!: string;

  @Prop({ required: true })
  rendererVersion!: string;

  /** Compare-and-swap token; an older renderer cannot replace a newer artifact. */
  @Prop({ required: true })
  revision!: string;

  @Prop({ type: Buffer, required: true, select: false })
  svgGzip!: Buffer;

  @Prop({ required: true })
  etag!: string;

  @Prop({ required: true })
  generatedAt!: Date;
}
export const StatsCardArtifactSchema =
  SchemaFactory.createForClass(StatsCardArtifact);
StatsCardArtifactSchema.index({ shareId: 1, theme: 1 }, { unique: true });
