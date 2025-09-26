export interface DatabaseUser {
    id: number;
    username: string;
}
export interface DatabaseImage {
    id: number;
    userId: number;
}
export interface DatabaseUserEngagement {
    userId: number;
    targetUserId: number;
    type: 'Follow' | 'Hide' | 'Block' | 'Mute';
}
export interface DatabaseImageEngagement {
    userId: number;
    imageId: number;
    type: 'Hide' | 'Like' | 'Dislike' | 'Heart' | 'Laugh' | 'Cry';
}
export interface IDatabaseProvider {
    findUserByUsername(username: string): Promise<DatabaseUser | null>;
    findUserEngagements(userId: number, type: 'Follow'): Promise<DatabaseUserEngagement[]>;
    findImageEngagements(userId: number, type: 'Hide'): Promise<DatabaseImageEngagement[]>;
}
export interface UsernameToUserIdResult {
    userId: number | null;
}
export interface HiddenImagesResult {
    imageIds: number[];
}
export interface FollowedUsersResult {
    userIds: number[];
}
export declare class DatabaseHelper {
    private provider;
    constructor(provider: IDatabaseProvider);
    getUserIdFromUsername(username: string): Promise<UsernameToUserIdResult>;
    getHiddenImageIds(userId: number): Promise<HiddenImagesResult>;
    getFollowedUserIds(userId: number): Promise<FollowedUsersResult>;
}
