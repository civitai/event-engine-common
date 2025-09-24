"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunk = chunk;
exports.sleep = sleep;
function chunk(arr, size) {
    if (size <= 0)
        throw new Error('chunk size must be greater than 0');
    const chunks = [];
    for (let i = 0; i < arr.length; i += size)
        chunks.push(arr.slice(i, i + size));
    return chunks;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
