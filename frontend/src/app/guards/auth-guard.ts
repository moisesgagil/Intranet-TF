import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from '../services/auth'; 
export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(Auth);
  const router = inject(Router);

  // Si el servicio dice que está autenticado (existe el token), dejamos pasar
  if (authService.estaAutenticado()) {
    return true;
  }

  // Si no está autenticado, lo redirigimos a la fuerza al login
  router.navigate(['/login']);
  return false;
};