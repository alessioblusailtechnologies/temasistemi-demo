import { Component, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ChatService, ChatMessage, ChatSource, ChatEvent } from '../../services/chat.service';

interface DisplayMessage extends ChatMessage {
  sources?: ChatSource[];
  status?: string;
  loading?: boolean;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.html',
  styleUrl: './chat.scss'
})
export class ChatComponent implements AfterViewChecked {
  input = '';
  messages: DisplayMessage[] = [];
  loading = false;
  private shouldScroll = false;

  suggestions = [
    'Quali fatture abbiamo ricevuto di recente?',
    'Trovami i contratti di fornitura energia',
    'Ci sono documenti tecnici relativi alla manutenzione?',
    'Elencami le fatture sopra 5000 euro',
  ];

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef;

  constructor(private chatService: ChatService, private sanitizer: DomSanitizer) {}

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  send(): void {
    const text = this.input.trim();
    if (!text || this.loading) return;

    // Aggiungi messaggio utente
    this.messages.push({ role: 'user', content: text });
    this.input = '';
    this.loading = true;
    this.shouldScroll = true;

    // Aggiungi placeholder risposta assistente
    const assistantMsg: DisplayMessage = {
      role: 'assistant',
      content: '',
      loading: true,
      status: 'Analizzo la richiesta...',
    };
    this.messages.push(assistantMsg);

    // Prepara history (escludi l'ultimo messaggio placeholder)
    const history: ChatMessage[] = this.messages
      .filter(m => m.content && !m.loading)
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    this.chatService.chat(text, history).subscribe({
      next: (event: ChatEvent) => {
        switch (event.type) {
          case 'status':
            assistantMsg.status = event.content || '';
            this.shouldScroll = true;
            break;
          case 'delta':
            if (assistantMsg.status) assistantMsg.status = '';
            assistantMsg.content += event.content || '';
            this.shouldScroll = true;
            break;
          case 'sources':
            assistantMsg.sources = event.sources || [];
            this.shouldScroll = true;
            break;
          case 'done':
            assistantMsg.loading = false;
            this.loading = false;
            this.shouldScroll = true;
            break;
          case 'error':
            assistantMsg.content = `Si è verificato un errore: ${event.message}`;
            assistantMsg.loading = false;
            assistantMsg.status = '';
            this.loading = false;
            break;
        }
      },
      error: () => {
        assistantMsg.content = 'Errore di connessione al server.';
        assistantMsg.loading = false;
        assistantMsg.status = '';
        this.loading = false;
      },
    });
  }

  useSuggestion(text: string): void {
    this.input = text;
    this.send();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  getDownloadUrl(nomeFile: string): string {
    return `/api/document/${encodeURIComponent(nomeFile)}/download`;
  }

  clearChat(): void {
    this.messages = [];
    this.loading = false;
  }

  /**
   * Rendering markdown: bold, italic, liste, tabelle, citazioni documento [file.pdf]
   */
  formatMarkdown(text: string): SafeHtml {
    const lines = text.split('\n');
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      // Rileva tabella markdown: riga con |, seguita da riga separatore |---|
      if (this.isTableRow(lines[i]) && i + 1 < lines.length && this.isTableSeparator(lines[i + 1])) {
        const tableLines: string[] = [];
        while (i < lines.length && this.isTableRow(lines[i])) {
          tableLines.push(lines[i]);
          i++;
          // Salta la riga separatore (---|---|---)
          if (tableLines.length === 1 && i < lines.length && this.isTableSeparator(lines[i])) {
            i++;
          }
        }
        out.push(this.buildTable(tableLines));
        continue;
      }

      out.push(lines[i]);
      i++;
    }

    let html = this.escapeHtmlSelective(out.join('\n'));

    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    // Citazioni documento [nome_file.ext] → link cliccabile
    html = html.replace(
      /\[([^\]]+?\.\w{2,5})\]/g,
      '<a class="doc-ref" href="/api/document/$1/download" target="_blank">$1</a>'
    );
    // Liste non ordinate
    html = html.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // Liste numerate
    html = html.replace(/^\d+\.\s(.+)$/gm, '<li>$1</li>');
    // Paragrafi (doppio a-capo)
    html = html.replace(/\n\n/g, '</p><p>');
    html = `<p>${html}</p>`;
    // Singolo a-capo → <br> (ma non dentro tag table)
    html = html.replace(/\n/g, '<br>');
    // Pulisci paragrafi vuoti e <br> spuri vicini a tabelle
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<br>(<table)/g, '$1');
    html = html.replace(/(<\/table>)<br>/g, '$1');
    html = html.replace(/<p>(<table)/g, '$1');
    html = html.replace(/(<\/table>)<\/p>/g, '$1');

    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  private isTableRow(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    return trimmed.includes('|') && !this.isTableSeparator(trimmed);
  }

  private isTableSeparator(line: string): boolean {
    if (!line) return false;
    return /^\|?[\s\-:|]+\|[\s\-:|]*$/.test(line.trim());
  }

  private buildTable(rows: string[]): string {
    if (rows.length === 0) return '';

    const parseCells = (row: string): string[] =>
      row.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - (row.trim().endsWith('|') ? 1 : 0));

    const headerCells = parseCells(rows[0]);
    let html = '<table class="chat-table"><thead><tr>';
    for (const cell of headerCells) {
      html += `<th>${this.escapeHtml(cell)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 1; r < rows.length; r++) {
      const cells = parseCells(rows[r]);
      html += '<tr>';
      for (let c = 0; c < headerCells.length; c++) {
        html += `<td>${this.escapeHtml(cells[c] || '')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  /**
   * Escape HTML ma preserva i tag <table> già costruiti.
   */
  private escapeHtmlSelective(text: string): string {
    const parts = text.split(/(<table.*?<\/table>)/s);
    return parts.map((part, i) => {
      // I pezzi dispari sono le tabelle (già HTML)
      if (i % 2 === 1) return part;
      return this.escapeHtml(part);
    }).join('');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private scrollToBottom(): void {
    try {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch { /* ignore */ }
  }
}
