import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AgentsService,
  Agent,
  AgentExecution,
  CreateAgentRequest,
} from '../../services/agents.service';

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './agents.html',
  styleUrl: './agents.scss',
})
export class AgentsComponent implements OnInit {
  agents: Agent[] = [];
  loading = false;
  showBanner = false;
  bannerText = '';
  bannerType: 'success' | 'error' = 'success';

  // Form modal
  showForm = false;
  editingAgent: Agent | null = null;
  form: CreateAgentRequest = this.emptyForm();

  // Executions modal
  showExecutions = false;
  executionsAgent: Agent | null = null;
  executions: AgentExecution[] = [];
  loadingExecutions = false;

  // Delete confirmation
  showDeleteConfirm = false;
  deletingAgent: Agent | null = null;

  // Running state
  runningIds = new Set<string>();

  cronPresets = [
    { label: 'Ogni ora', value: '0 * * * *' },
    { label: 'Ogni giorno alle 8:00', value: '0 8 * * *' },
    { label: 'Ogni lunedì alle 9:00', value: '0 9 * * 1' },
    { label: 'Ogni primo del mese', value: '0 8 1 * *' },
    { label: 'Personalizzato', value: '' },
  ];

  promptExamples = [
    'Fammi un report PDF di tutti i documenti sulle risorse umane ed inviamelo via mail a hr@azienda.it',
    'Analizza le fatture del mese corrente e genera un riepilogo con totali per fornitore',
    'Controlla se ci sono contratti in scadenza nei prossimi 30 giorni e notificami via email',
    'Estrai tutti i DDT della settimana e crea un foglio Excel riepilogativo',
  ];

  constructor(private agentsService: AgentsService) {}

  ngOnInit(): void {
    this.loadAgents();
  }

  loadAgents(): void {
    this.loading = true;
    this.agentsService.list().subscribe({
      next: (agents) => {
        this.agents = agents;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.showNotification(
          `Errore nel caricamento: ${err.message || 'servizio non disponibile'}`,
          'error'
        );
      },
    });
  }

  // ─── Form ───

  openCreate(): void {
    this.editingAgent = null;
    this.form = this.emptyForm();
    this.showForm = true;
  }

  openEdit(agent: Agent): void {
    this.editingAgent = agent;
    this.form = {
      name: agent.name,
      prompt: agent.prompt,
      trigger_type: agent.trigger_type,
      cron_expression: agent.cron_expression || '',
      enabled: agent.enabled,
    };
    this.showForm = true;
  }

  closeForm(): void {
    this.showForm = false;
    this.editingAgent = null;
  }

  applyCronPreset(value: string): void {
    if (value) {
      this.form.cron_expression = value;
    }
  }

  fillPrompt(text: string): void {
    this.form.prompt = text;
  }

  saveAgent(): void {
    if (!this.form.name.trim() || !this.form.prompt.trim()) return;
    if (this.form.trigger_type === 'scheduled' && !this.form.cron_expression?.trim()) return;

    const request: CreateAgentRequest = {
      ...this.form,
      name: this.form.name.trim(),
      prompt: this.form.prompt.trim(),
    };

    if (request.trigger_type === 'manual') {
      delete request.cron_expression;
    }

    const obs = this.editingAgent
      ? this.agentsService.update(this.editingAgent.id, request)
      : this.agentsService.create(request);

    obs.subscribe({
      next: () => {
        this.closeForm();
        this.loadAgents();
        this.showNotification(
          this.editingAgent ? 'Agent aggiornato con successo' : 'Agent creato con successo',
          'success'
        );
      },
      error: (err) => {
        this.showNotification(
          `Errore: ${err.error?.message || err.message || 'operazione fallita'}`,
          'error'
        );
      },
    });
  }

  // ─── Delete ───

  confirmDelete(agent: Agent): void {
    this.deletingAgent = agent;
    this.showDeleteConfirm = true;
  }

  closeDeleteConfirm(): void {
    this.showDeleteConfirm = false;
    this.deletingAgent = null;
  }

  deleteAgent(): void {
    if (!this.deletingAgent) return;
    this.agentsService.delete(this.deletingAgent.id).subscribe({
      next: () => {
        this.closeDeleteConfirm();
        this.loadAgents();
        this.showNotification('Agent eliminato', 'success');
      },
      error: (err) => {
        this.closeDeleteConfirm();
        this.showNotification(
          `Errore eliminazione: ${err.message || 'operazione fallita'}`,
          'error'
        );
      },
    });
  }

  // ─── Run ───

  runAgent(agent: Agent): void {
    this.runningIds.add(agent.id);
    this.agentsService.run(agent.id).subscribe({
      next: (execution) => {
        this.runningIds.delete(agent.id);
        if (execution.status === 'failed') {
          this.showNotification(
            `Agent "${agent.name}" fallito: ${execution.error || 'errore sconosciuto'}`,
            'error'
          );
        } else {
          this.showNotification(
            `Agent "${agent.name}" completato con successo`,
            'success'
          );
        }
      },
      error: (err) => {
        this.runningIds.delete(agent.id);
        this.showNotification(
          `Errore esecuzione: ${err.message || 'operazione fallita'}`,
          'error'
        );
      },
    });
  }

  isRunning(id: string): boolean {
    return this.runningIds.has(id);
  }

  // ─── Executions ───

  openExecutions(agent: Agent): void {
    this.executionsAgent = agent;
    this.showExecutions = true;
    this.loadExecutions(agent.id);
  }

  closeExecutions(): void {
    this.showExecutions = false;
    this.executionsAgent = null;
    this.executions = [];
  }

  loadExecutions(agentId: string): void {
    this.loadingExecutions = true;
    this.agentsService.getExecutions(agentId).subscribe({
      next: (execs) => {
        this.executions = execs;
        this.loadingExecutions = false;
      },
      error: () => {
        this.loadingExecutions = false;
      },
    });
  }

  // ─── Toggle enabled ───

  toggleEnabled(agent: Agent): void {
    this.agentsService
      .update(agent.id, {
        name: agent.name,
        prompt: agent.prompt,
        trigger_type: agent.trigger_type,
        cron_expression: agent.cron_expression,
        enabled: !agent.enabled,
      })
      .subscribe({
        next: (updated) => {
          agent.enabled = updated.enabled;
        },
        error: () => {
          this.showNotification('Errore aggiornamento stato', 'error');
        },
      });
  }

  // ─── Helpers ───

  private emptyForm(): CreateAgentRequest {
    return {
      name: '',
      prompt: '',
      trigger_type: 'manual',
      cron_expression: '',
      enabled: true,
    };
  }

  private showNotification(text: string, type: 'success' | 'error'): void {
    this.bannerText = text;
    this.bannerType = type;
    this.showBanner = true;
    setTimeout(() => (this.showBanner = false), 5000);
  }

  closeBanner(): void {
    this.showBanner = false;
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }

  describeCron(cron: string | undefined): string {
    if (!cron) return '—';
    const map: Record<string, string> = {
      '0 * * * *': 'Ogni ora',
      '0 8 * * *': 'Ogni giorno alle 8:00',
      '0 9 * * 1': 'Ogni lunedì alle 9:00',
      '0 8 1 * *': 'Ogni primo del mese alle 8:00',
    };
    return map[cron] || cron;
  }

  statusLabel(status: string): string {
    const map: Record<string, string> = {
      pending: 'In attesa',
      running: 'In esecuzione',
      completed: 'Completato',
      failed: 'Fallito',
    };
    return map[status] || status;
  }

  statusClass(status: string): string {
    const map: Record<string, string> = {
      pending: 'status-pending',
      running: 'status-running',
      completed: 'status-completed',
      failed: 'status-failed',
    };
    return map[status] || '';
  }
}
