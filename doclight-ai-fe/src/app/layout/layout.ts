import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ChatComponent } from '../features/chat/chat';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, ChatComponent],
  templateUrl: './layout.html',
  styleUrl: './layout.scss'
})
export class LayoutComponent {
  chatOpen = false;

  toggleChat(): void {
    this.chatOpen = !this.chatOpen;
  }
}
