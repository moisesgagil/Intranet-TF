import { Component, ChangeDetectorRef, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Auth } from '../../services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrls: ['./login.css']
})
export class Login implements OnInit {
  loginData = {
    username: '',
    password: ''
  };

  showPassword = false;
  errorMessage = '';
  loading = false;
  rememberMe = false;

  private authService = inject(Auth);
  private router = inject(Router);
  private cd = inject(ChangeDetectorRef);

  ngOnInit() {
    const savedUser = localStorage.getItem('techfoods_user');
    if (savedUser) {
      this.loginData.username = savedUser;
      this.rememberMe = true;
    }
  }

  onLogin() {
    if (!this.loginData.username || !this.loginData.password) {
      this.errorMessage = 'Por favor, completa todos los campos.';
      return;
    }

    this.loading = true;
    this.errorMessage = '';

    if (this.rememberMe) {
      localStorage.setItem('techfoods_user', this.loginData.username);
    } else {
      localStorage.removeItem('techfoods_user');
    }

    this.authService.login(this.loginData).subscribe({
      next: (res) => {
        this.loading = false;
        this.cd.detectChanges(); // Forzamos actualización de UI

        // The token is automatically saved by authService, but let's make sure
        // res.rol is now an array. If length > 1, redirect to role selection
        if (Array.isArray(res.rol) && res.rol.length > 1) {
          localStorage.setItem('usuario_roles', JSON.stringify(res.rol));
          this.router.navigate(['/seleccionar-rol']);
        } else {
          // If only 1 role or string, set it as the active role
          const activeRole = Array.isArray(res.rol) ? res.rol[0] : res.rol;
          localStorage.setItem('active_role', activeRole);
          this.router.navigate(['/inicio']);
        }
      },
      error: (err) => {
        this.errorMessage = err.error?.error || err.error?.message || 'Usuario o contraseña incorrectos.';
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