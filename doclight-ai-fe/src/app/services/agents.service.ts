import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Agent {
  id: string;
  name: string;
  prompt: string;
  trigger_type: 'manual' | 'scheduled';
  cron_expression?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentExecution {
  id: string;
  agent_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at?: string;
  result?: string;
  error?: string;
}

export interface CreateAgentRequest {
  name: string;
  prompt: string;
  trigger_type: 'manual' | 'scheduled';
  cron_expression?: string;
  enabled: boolean;
}

export interface UpdateAgentRequest extends CreateAgentRequest {}

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private readonly apiUrl = '/api/agents';

  constructor(private http: HttpClient) {}

  list(): Observable<Agent[]> {
    return this.http.get<Agent[]>(this.apiUrl);
  }

  get(id: string): Observable<Agent> {
    return this.http.get<Agent>(`${this.apiUrl}/${id}`);
  }

  create(request: CreateAgentRequest): Observable<Agent> {
    return this.http.post<Agent>(this.apiUrl, request);
  }

  update(id: string, request: UpdateAgentRequest): Observable<Agent> {
    return this.http.put<Agent>(`${this.apiUrl}/${id}`, request);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  run(id: string): Observable<AgentExecution> {
    return this.http.post<AgentExecution>(`${this.apiUrl}/${id}/run`, {});
  }

  getExecutions(id: string): Observable<AgentExecution[]> {
    return this.http.get<AgentExecution[]>(`${this.apiUrl}/${id}/executions`);
  }
}
