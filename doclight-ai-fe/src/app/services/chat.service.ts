import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSource {
  nome_file: string;
  score: number;
  score_percent: number;
  tipo_documento: string;
  data_documento: string;
  semantic_profile: string;
}

export interface ChatEvent {
  type: 'status' | 'delta' | 'sources' | 'done' | 'error';
  content?: string;
  sources?: ChatSource[];
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly apiUrl = '/api';

  constructor(private ngZone: NgZone) {}

  /**
   * Invia un messaggio e riceve la risposta in streaming via SSE (fetch + ReadableStream).
   * Usa POST con body, quindi non possiamo usare EventSource nativo.
   */
  chat(message: string, history: ChatMessage[]): Observable<ChatEvent> {
    return new Observable(subscriber => {
      const controller = new AbortController();

      fetch(`${this.apiUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const read = (): Promise<void> => {
            return reader.read().then(({ done, value }) => {
              if (done) {
                this.ngZone.run(() => subscriber.complete());
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                  try {
                    const event: ChatEvent = JSON.parse(trimmed.slice(6));
                    this.ngZone.run(() => subscriber.next(event));
                  } catch { /* skip malformed */ }
                }
              }

              return read();
            });
          };

          return read();
        })
        .catch(err => {
          if (err.name !== 'AbortError') {
            this.ngZone.run(() => subscriber.error(err));
          }
        });

      return () => controller.abort();
    });
  }
}
