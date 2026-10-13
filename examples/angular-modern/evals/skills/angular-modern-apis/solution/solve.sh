#!/bin/bash
# The reference solution: the component, modernized.
cat > src/app/user-profile.component.ts <<'EOF'
import { Component, inject, input, output } from '@angular/core';
import { UserService } from './user.service';

@Component({
  selector: 'app-user-profile',
  standalone: true,
  template: `
    @if (user) {
      <h1>{{ user.name }}</h1>
      <p>Age: {{ user.age }}</p>
    } @else {
      <p>Loading...</p>
    }
    <ul>
      @for (skill of user?.skills; track skill) {
        <li>{{ skill }}</li>
      }
    </ul>
    <button (click)="onSave()">Save</button>
  `
})
export class UserProfileComponent {
  private userService = inject(UserService);

  userId = input.required<string>();
  showDetails = input(false);
  saved = output<void>();

  user: any;

  ngOnInit() {
    this.user = this.userService.getUser(this.userId());
  }

  onSave() {
    this.userService.saveUser(this.user);
    this.saved.emit();
  }
}
EOF
