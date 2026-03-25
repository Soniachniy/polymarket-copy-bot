type WsHandler = (msg: { type: string; payload: unknown; ts: number }) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers: WsHandler[] = [];
  private reconnectDelay = 1000;
  private maxDelay = 30000;
  private shouldReconnect = false;

  connect(): void {
    this.shouldReconnect = true;
    this.open();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }

  on(handler: WsHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private open(): void {
    const token = localStorage.getItem('token');
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.shouldReconnect) {
        setTimeout(() => this.open(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }
}

export const wsClient = new WsClient();
