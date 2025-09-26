"use strict";
// Database abstraction types for cross-app compatibility
// This allows different apps to provide their own database implementations
// while maintaining a consistent interface for the event-engine services
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseHelper = void 0;
// Helper class that provides common database operations using the provider
class DatabaseHelper {
    constructor(provider) {
        this.provider = provider;
        this.provider = provider;
    }
    async getUserIdFromUsername(username) {
        try {
            const user = await this.provider.findUserByUsername(username);
            return { userId: user?.id ?? null };
        }
        catch (error) {
            console.error('DatabaseHelper: Error finding user by username:', error);
            return { userId: null };
        }
    }
    async getHiddenImageIds(userId) {
        try {
            const engagements = await this.provider.findImageEngagements(userId, 'Hide');
            const imageIds = engagements.map(e => e.imageId);
            return { imageIds };
        }
        catch (error) {
            console.error('DatabaseHelper: Error finding hidden images:', error);
            return { imageIds: [] };
        }
    }
    async getFollowedUserIds(userId) {
        try {
            const engagements = await this.provider.findUserEngagements(userId, 'Follow');
            const userIds = engagements.map(e => e.targetUserId);
            return { userIds };
        }
        catch (error) {
            console.error('DatabaseHelper: Error finding followed users:', error);
            return { userIds: [] };
        }
    }
}
exports.DatabaseHelper = DatabaseHelper;
