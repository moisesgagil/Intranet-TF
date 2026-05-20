import { Component, ChangeDetectorRef, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Auth } from '../../services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule], // Vitales para *ngIf y [(ngModel)]
  templateUrl: './login.html'
})
export class Login {
  loginData = {
    username: '',
    password: ''
  };

  showPassword = false;
  errorMessage = '';
  loading = false;

  private authService = inject(Auth);
  private router = inject(Router);
  private cd = inject(ChangeDetectorRef);

  onLogin() {
    if (!this.loginData.username || !this.loginData.password) {
      this.errorMessage = 'Por favor, completa todos los campos.';
      return;
    }

    this.loading = true;
    this.errorMessage = '';

    this.authService.login(this.loginData).subscribe({
      next: (res) => {
        this.loading = false;
        this.cd.detectChanges(); // Forzamos actualización de UI
        
        const rol = res.rol?.toLowerCase();

        // Como estamos en la Intranet, mandamos a todos al Inicio por ahora.
        // Después podemos separarlos si necesitas vistas exclusivas por rol.
        this.router.navigate(['/inicio']);
      },
      error: (err) => {
        this.errorMessage = err.error?.error || 'Usuario o contraseña incorrectos.';
        this.loading = false;
        this.cd.detectChanges(); // Quita el spinner atascado
        console.error('Login Error:', err);
      }
    });
  }

  togglePassword() {
    this.showPassword = !this.showPassword;
  }
}