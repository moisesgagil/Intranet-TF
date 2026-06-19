import { Routes } from '@angular/router';
import { Layout } from './components/layout/layout';
import { Inicio } from './pages/inicio/inicio';
import { Login } from './pages/login/login';
import { Perfil } from './components/perfil/perfil';
import { Configuracion } from './pages/configuracion/configuracion';
import { Usuarios } from './pages/usuarios/usuarios';
import { authGuard } from './guards/auth-guard'; // Nuestro guardián

export const routes: Routes = [
  // 1. Si entran a la raíz, redirige al login de inmediato
  { 
    path: '', 
    redirectTo: 'login', 
    pathMatch: 'full' 
  },
  
  // 2. Ruta pública del Login
  { 
    path: 'login', 
    component: Login 
  },
  
  // 3. RUTAS PROTEGIDAS (Estructura corregida con Perfil incluido 🚀)
  {
    path: '',
    component: Layout,
    children: [
      { 
        path: 'inicio', 
        component: Inicio, 
        canActivate: [authGuard] // Candado para el muro
      },
      { 
        path: 'perfil', 
        component: Perfil, 
        canActivate: [authGuard] // <-- ¡LE PONEMOS EL CANDADO TAMBIÉN A TU NUEVO PERFIL POKA!
      },
      { 
        path: 'configuracion', 
        component: Configuracion, 
        canActivate: [authGuard] 
      },
      { 
        path: 'usuarios', 
        component: Usuarios, 
        canActivate: [authGuard] 
      }
    ]
  },
  
  // 4. Cualquier otra ruta loca que escriban, los rebota al login
  { 
    path: '**', 
    redirectTo: 'login' 
  }
];