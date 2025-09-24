"use strict";
// Feed input types - parameters for feed functions
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMAGE_SORT_OPTIONS = exports.MODEL_SORT_OPTIONS = void 0;
// Common sort mappings
exports.MODEL_SORT_OPTIONS = {
    Newest: { field: 'publishedAtUnix', direction: 'desc' },
    Oldest: { field: 'publishedAtUnix', direction: 'asc' },
    'Most Downloaded': { field: 'downloadCount', direction: 'desc' },
    'Highest Rated': { field: 'rating', direction: 'desc' },
    'Most Liked': { field: 'thumbsUpCount', direction: 'desc' },
    'Most Discussed': { field: 'commentCount', direction: 'desc' },
    'Most Collected': { field: 'collectedCount', direction: 'desc' },
    'Most Tipped': { field: 'tippedAmountCount', direction: 'desc' },
};
exports.IMAGE_SORT_OPTIONS = {
    Newest: { field: 'sortAtUnix', direction: 'desc' },
    Oldest: { field: 'sortAtUnix', direction: 'asc' },
    'Most Reactions': { field: 'reactionCount', direction: 'desc' },
    'Most Comments': { field: 'commentCount', direction: 'desc' },
    'Most Collected': { field: 'collectedCount', direction: 'desc' },
};
