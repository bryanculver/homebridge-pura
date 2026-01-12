/**
 * WebSocket subscriber.
 */

import WebSocket from 'ws';

export const WEBSOCKET_URL = 'wss://socket.trypura.io';

export type MessageHandler = (data: any) => void | Promise<void>;

/**
 * WebSocket subscriber for real-time Pura device updates.
 */
export class WebSocketSubscriber {
  private token: string;
  private ws: WebSocket | null = null;
  private _running = false;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Returns `true` if the subscriber is running.
   */
  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Connect to the websocket.
   */
  async connect(onMessage: MessageHandler): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.token}`,
      };

      this.ws = new WebSocket(WEBSOCKET_URL, { headers });

      this.ws.on('open', () => {
        this._running = true;
        console.debug('Connected to websocket');
        resolve();
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = data.toString();
          let parsedData: any;

          try {
            parsedData = JSON.parse(message);
          } catch {
            parsedData = message;
          }

          try {
            await onMessage(parsedData);
          } catch (error) {
            console.error('Error handling WebSocket message:', error);
          }
        } catch (error) {
          console.error('Error processing WebSocket data:', error);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.debug('WebSocket error:', error);
        this._running = false;
        reject(error);
      });

      this.ws.on('close', () => {
        this._running = false;
        console.debug('WebSocket disconnected');
      });
    });
  }

  /**
   * Start the subscriber in the background.
   */
  start(onMessage: MessageHandler): void {
    this.connect(onMessage).catch((error) => {
      console.error('Failed to connect to WebSocket:', error);
    });
  }

  /**
   * Stop the subscriber.
   */
  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this._running = false;
    }
  }
}
