"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalsService = void 0;
class SignalsService {
    constructor(apiUrl, enabled = true) {
        this.signalsApiUrl = apiUrl || '';
        this.enabled = enabled && !!this.signalsApiUrl;
        if (!this.enabled) {
            console.warn('[SignalsService] Signals API disabled or URL not configured');
        }
    }
    /**
     * Send a signal to a specific topic
     * @param topic The topic to send the signal to
     * @param signalName The name of the signal event
     * @param payload The payload to send
     */
    async sendSignal(topic, signalName, payload) {
        if (!this.enabled)
            return;
        const url = `${this.signalsApiUrl}/topics/${topic}/signals/${signalName}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                throw new Error(`Signal API returned ${response.status}: ${response.statusText}`);
            }
        }
        catch (error) {
            console.error(`[SignalsService] Failed to send signal to topic ${topic}:`, error);
            throw error;
        }
    }
    isEnabled() {
        return this.enabled;
    }
}
exports.SignalsService = SignalsService;
