export type ArticleMetrics = {
    Cry: number;
    Dislike: number;
    Heart: number;
    Laugh: number;
    Like: number;
    collectedCount: number;
    commentCount: number;
    tippedAmount: number;
    tippedCount: number;
};
export type BountyMetrics = {
    benefactorCount: number;
    commentCount: number;
    entryCount: number;
    favoriteCount: number;
    trackCount: number;
    unitAmount: number;
};
export type BountyEntryMetrics = {
    Cry: number;
    Dislike: number;
    Heart: number;
    Laugh: number;
    Like: number;
    unitAmount: number;
};
export type CollectionMetrics = {
    contributorCount: number;
    followerCount: number;
    itemCount: number;
};
export type ImageMetrics = {
    Collection: number;
    Cry: number;
    Dislike: number;
    Heart: number;
    Laugh: number;
    Like: number;
    commentCount: number;
    tippedAmount: number;
    tippedCount: number;
};
export type ModelMetrics = {
    collectedCount: number;
    commentCount: number;
    imageCount: number;
    ratingCount: number;
    thumbsDownCount: number;
    thumbsUpCount: number;
    tippedAmount: number;
    tippedCount: number;
};
export type ModelVersionMetrics = {
    imageCount: number;
    ratingCount: number;
    thumbsDownCount: number;
    thumbsUpCount: number;
};
export type PostMetrics = {
    Cry: number;
    Dislike: number;
    Heart: number;
    Laugh: number;
    Like: number;
    collectedCount: number;
    commentCount: number;
    reactionCount: number;
    tippedAmount: number;
    tippedCount: number;
};
export type TagMetrics = {
    followerCount: number;
    hiddenCount: number;
};
export type UserMetrics = {
    articleCount: number;
    bountyCount: number;
    followerCount: number;
    followingCount: number;
    hiddenCount: number;
    reactionCount: number;
    tippedAmount: number;
    tippedCount: number;
    tipsGivenAmount: number;
    tipsGivenCount: number;
};
export type EntityMetrics = {
    type: 'Article';
    metrics: ArticleMetrics;
} | {
    type: 'Bounty';
    metrics: BountyMetrics;
} | {
    type: 'BountyEntry';
    metrics: BountyEntryMetrics;
} | {
    type: 'Collection';
    metrics: CollectionMetrics;
} | {
    type: 'Image';
    metrics: ImageMetrics;
} | {
    type: 'Model';
    metrics: ModelMetrics;
} | {
    type: 'ModelVersion';
    metrics: ModelVersionMetrics;
} | {
    type: 'Post';
    metrics: PostMetrics;
} | {
    type: 'Tag';
    metrics: TagMetrics;
} | {
    type: 'User';
    metrics: UserMetrics;
};
export declare const ENTITY_METRIC_TYPES: {
    readonly Article: readonly ["Cry", "Dislike", "Heart", "Laugh", "Like", "collectedCount", "commentCount", "tippedAmount", "tippedCount"];
    readonly Bounty: readonly ["benefactorCount", "commentCount", "entryCount", "favoriteCount", "trackCount", "unitAmount"];
    readonly BountyEntry: readonly ["Cry", "Dislike", "Heart", "Laugh", "Like", "unitAmount"];
    readonly Collection: readonly ["contributorCount", "followerCount", "itemCount"];
    readonly Image: readonly ["Collection", "ReactionCry", "ReactionDislike", "ReactionHeart", "ReactionLaugh", "ReactionLike", "commentCount", "tippedAmount", "tippedCount"];
    readonly Model: readonly ["collectedCount", "commentCount", "imageCount", "ratingCount", "thumbsDownCount", "thumbsUpCount", "tippedAmount", "tippedCount"];
    readonly ModelVersion: readonly ["imageCount", "ratingCount", "thumbsDownCount", "thumbsUpCount"];
    readonly Post: readonly ["Cry", "Dislike", "Heart", "Laugh", "Like", "collectedCount", "commentCount", "reactionCount", "tippedAmount", "tippedCount"];
    readonly Tag: readonly ["followerCount", "hiddenCount"];
    readonly User: readonly ["articleCount", "bountyCount", "followerCount", "followingCount", "hiddenCount", "reactionCount", "tippedAmount", "tippedCount", "tipsGivenAmount", "tipsGivenCount"];
};
export type EntityType = keyof typeof ENTITY_METRIC_TYPES;
export type EntityMetricMap = {
    Article: ArticleMetrics;
    Bounty: BountyMetrics;
    BountyEntry: BountyEntryMetrics;
    Collection: CollectionMetrics;
    Image: ImageMetrics;
    Model: ModelMetrics;
    ModelVersion: ModelVersionMetrics;
    Post: PostMetrics;
    Tag: TagMetrics;
    User: UserMetrics;
};
