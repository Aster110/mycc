export interface RegisterMessage {
    type: "register";
    deviceId: string;
    pairCode: string;
}
export interface PairMessage {
    type: "pair";
    deviceId: string;
    pairCode: string;
}
export interface ChatMessage {
    type: "chat";
    requestId: string;
    message: string;
    sessionId?: string;
}
export interface ChatResponse {
    type: "chat_response";
    requestId: string;
    data: unknown;
}
export interface ChatDone {
    type: "chat_done";
    requestId: string;
    sessionId: string;
}
export interface ChatError {
    type: "chat_error";
    requestId: string;
    error: string;
}
export interface PairSuccess {
    type: "pair_success";
    deviceId: string;
}
export interface DeviceOffline {
    type: "device_offline";
}
export interface Ping {
    type: "ping";
}
export interface Pong {
    type: "pong";
}
export type ClientMessage = RegisterMessage | PairMessage | ChatMessage | Ping;
export type ServerMessage = ChatResponse | ChatDone | ChatError | PairSuccess | DeviceOffline | Pong;
//# sourceMappingURL=types.d.ts.map