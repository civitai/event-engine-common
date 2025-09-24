export declare class SignalsService {
    private signalsApiUrl;
    private enabled;
    constructor(apiUrl?: string, enabled?: boolean);
    /**
     * Send a signal to a specific topic
     * @param topic The topic to send the signal to
     * @param signalName The name of the signal event
     * @param payload The payload to send
     */
    sendSignal<T = any>(topic: string, signalName: string, payload: T): Promise<void>;
    isEnabled(): boolean;
}
