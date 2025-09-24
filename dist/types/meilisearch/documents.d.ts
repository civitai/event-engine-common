export interface UserInfo {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
}
export interface ModelMetrics {
    downloadCount: number;
    favoriteCount: number;
    commentCount: number;
    ratingCount: number;
    rating: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    collectedCount: number;
    tippedAmountCount: number;
}
export interface ImageMetrics {
    reactionCount: number;
    commentCount: number;
    collectedCount: number;
}
export interface ModelRawItem {
    id: number;
    name: string;
    description?: string | null;
    type: string;
    poi?: boolean;
    minor?: boolean;
    sfwOnly?: boolean;
    nsfw: boolean;
    nsfwLevel: number;
    allowNoCredit?: boolean;
    allowCommercialUse?: string[];
    allowDerivatives?: boolean;
    allowDifferentLicense?: boolean;
    status: string;
    createdAt: Date;
    lastVersionAt: Date;
    lastVersionAtUnix?: number;
    publishedAt?: Date | null;
    publishedAtUnix?: number;
    locked: boolean;
    earlyAccessDeadline?: Date | null;
    mode?: string | null;
    availability?: string;
    rank: {
        downloadCount: number;
        thumbsUpCount: number;
        thumbsDownCount: number;
        commentCount: number;
        ratingCount: number;
        rating: number;
        collectedCount: number;
        tippedAmountCount: number;
    };
    tagsOnModels: {
        tagId: number;
        name: string;
    }[];
    hashes: string[];
    modelVersions: {
        id: number;
        name: string;
        earlyAccessTimeFrame: number;
        baseModel: string;
        baseModelType: string;
        createdAt: Date;
        trainingStatus: string;
        trainedWords?: string[];
        vaeId: number | null;
        publishedAt: Date | null;
        status: string;
        covered: boolean;
    }[];
    user: {
        id: number;
        username: string | null;
        deletedAt: Date | null;
        image: string | null;
        profilePicture?: {
            id: number;
            name: string;
            url: string;
            nsfw: boolean;
            width: number;
            height: number;
            hash: string;
            type: string;
            metadata: Record<string, any>;
            createdAt: Date;
            userId: number;
        } | null;
        cosmetics?: {
            cosmeticId: number;
            data: Record<string, any>;
            cosmetic: {
                id: number;
                name: string;
                type: string;
                source: string;
                data: Record<string, any>;
            };
        }[];
    };
    cosmetic?: {
        id: number;
        type: string;
        name: string;
        data: Record<string, any>;
        claimKey?: string;
    } | null;
    [key: string]: any;
}
export interface ImageMetricsSearchIndexRecord {
    id: number;
    index: number;
    postId: number;
    url: string;
    nsfwLevel: number;
    aiNsfwLevel: number;
    combinedNsfwLevel: number;
    width: number;
    height: number;
    hash: string;
    hideMeta: boolean;
    sortAt: Date;
    sortAtUnix: number;
    type: string;
    userId: number;
    publishedAt?: Date;
    publishedAtUnix?: number;
    existedAtUnix: number;
    hasMeta: boolean;
    hasPositivePrompt?: boolean;
    onSite: boolean;
    postedToId?: number;
    needsReview: string | null;
    minor?: boolean;
    poi: boolean;
    acceptableMinor?: boolean;
    blockedFor: string | null;
    remixOfId?: number | null;
    availability?: string;
    baseModel: string;
    modelVersionIds: number[];
    modelVersionIdsManual: number[];
    toolIds: number[];
    techniqueIds: number[];
    tagIds: number[];
    reactionCount: number;
    commentCount: number;
    collectedCount: number;
    flags?: {
        promptNsfw?: boolean;
        [key: string]: any;
    };
    [key: string]: any;
}
export interface ImageFeedResult extends ImageMetricsSearchIndexRecord {
    stats: {
        likeCountAllTime: number;
        laughCountAllTime: number;
        heartCountAllTime: number;
        cryCountAllTime: number;
        commentCountAllTime: number;
        collectedCountAllTime: number;
        tippedAmountCountAllTime: number;
        dislikeCountAllTime: number;
        viewCountAllTime: number;
    };
}
export interface ModelFeedResponse {
    items: ModelRawItem[];
    nextCursor?: string | bigint | number | Date;
    isPrivate: boolean;
}
export interface ImageFeedResponse {
    data: ImageFeedResult[];
    nextCursor?: number;
}
