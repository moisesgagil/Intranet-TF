import { Component, OnInit, inject, HostListener, ChangeDetectorRef } from '@angular/core';
import { RouterOutlet, RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule, DatePipe } from '@angular/common'; 
import { Chat } from '../../services/chat';
import { Auth } from '../../services/auth';
import { SocketService } from '../../services/socket';


// esto es una prueba de git hub
@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, RouterModule, FormsModule, CommonModule, DatePipe],
  templateUrl: './layout.html'
})
export class Layout implements OnInit {
  private chatAPI = inject(Chat);
  private authAPI = inject(Auth);
  private router = inject(Router);
  private socketAPI = inject(SocketService);
  private cdr = inject(ChangeDetectorRef);

  menuPerfilAbierto = false;
  chatAbierto = false;
  chatsAbiertos: any[] = []; 
  mensajes: any[] = [];
  
  miUsuario = localStorage.getItem('usuarioNombre') || 'Nelson';
  rolActivo: string = localStorage.getItem('active_role') || 'usuario';

  // LA LISTA DE COMPAÑEROS AHORA NACE VACÍA
  companeros: any[] = [];
  terminoBusqueda = '';

  @HostListener('document:click')
  clicGlobal() {
    if (this.menuPerfilAbierto) {
      this.menuPerfilAbierto = false;
      this.cdr.detectChanges(); // Despierta Angular al cerrar el menú globalmente
    }
  }

  get iniciales(): string {
    const nombres = this.miUsuario.trim().split(' ');
    if (nombres.length >= 2) {
      return (nombres[0][0] + nombres[nombres.length - 1][0]).toUpperCase();
    }
    return this.miUsuario.substring(0, 2).toUpperCase();
  }

  toggleMenuPerfil(evento: MouseEvent) {
    evento.stopPropagation();
    this.menuPerfilAbierto = !this.menuPerfilAbierto;
    this.cdr.detectChanges(); // Despierta Angular al alternar el perfil
  }

  ejecutarCerrarSesion() {
    this.authAPI.cerrarSesion();
    this.router.navigate(['/login']);
  }

  private quitarTildes(texto: string): string {
    return texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  // FILTRADO Y ORDENAMIENTO EN VIVO
  get companerosFiltrados() {
    // Primero ordenamos: Los 'online === true' van arriba
    const listaOrdenada = [...this.companeros].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

    if (!this.terminoBusqueda.trim()) {
      return listaOrdenada;
    }

    const terminoLimpio = this.quitarTildes(this.terminoBusqueda.toLowerCase());
    return listaOrdenada.filter(persona => {
      const nombreLimpio = this.quitarTildes(persona.nombre.toLowerCase());
      return nombreLimpio.includes(terminoLimpio);
    });
  }

  ngOnInit() {
    this.cargarHistorial();
    this.cargarUsuariosDeLaEmpresa(); // CARGAMOS LA LISTA REAL

    this.socketAPI.registrarUsuario(this.miUsuario);

    this.socketAPI.onRecibirMensaje().subscribe({
      next: (msj) => {
        this.mensajes.push(msj);
        
        const chatExistente = this.chatsAbiertos.find(c => c.nombre === msj.emisor);
        if (!chatExistente) {
          const compa = this.companeros.find(c => c.nombre === msj.emisor) || { 
            nombre: msj.emisor, 
            online: true,
            rol: 'usuario'
          };
          this.abrirConversacion(compa);
        }
        this.cdr.detectChanges(); // El radar de Angular se activa al recibir un mensaje en vivo
      }
    });

    this.socketAPI.onConfirmarMensajeEnviado().subscribe({
      next: (msj) => {
        const existe = this.mensajes.some(m => m.emisor === msj.emisor && m.texto === msj.texto && m.fecha === msj.fecha);
        if (!existe) {
          this.mensajes.push(msj);
          this.cdr.detectChanges(); // El radar se activa al confirmar tu mensaje enviado
        }
      }
    });
  }

  // PETICIÓN AL BACKEND PARA TRAER LOS MIEMBROS Y ASIGNARLES COLOR/INICIAL
  cargarUsuariosDeLaEmpresa() {
    this.chatAPI.obtenerUsuarios().subscribe({
      next: (data) => {
        // Excluimos a nuestro propio usuario de la lista para no chatear con nosotros mismos
        this.companeros = data.filter(u => u.nombre !== this.miUsuario).map(u => {
          const nombres = u.nombre.split(' ');
          return {
            nombre: u.nombre,
            username: u.username,
            online: u.online,
            inicial: nombres.length >= 2 ? (nombres[0][0] + nombres[1][0]).toUpperCase() : u.nombre.substring(0,2).toUpperCase(),
            color: u.online ? 'bg-emerald-600' : 'bg-slate-500' // Verde si está online, gris si no
          };
        });
        this.cdr.detectChanges(); // Fuerza el pintado de la barra lateral al traer los usuarios
      },
      error: (err) => console.error('Error cargando miembros reales', err)
    });
  }

  toggleListaChat() {
    this.chatAbierto = !this.chatAbierto;
    this.cdr.detectChanges(); // Asegura la transición visual inmediata de la barra de chat
  }

  abrirConversacion(persona: any) {
    const chatExistente = this.chatsAbiertos.find(c => c.nombre === persona.nombre);
    if (chatExistente) {
      chatExistente.minimizado = false;
    } else {
      this.chatsAbiertos.push({ 
        ...persona, 
        minimizado: false, 
        nuevoMensajeTexto: ''
      });
    }
    this.cdr.detectChanges(); // Renderiza la ventana flotante recién abierta al milisegundo
  }

  toggleMinimizarChat(chat: any) {
    chat.minimizado = !chat.minimizado;
    this.cdr.detectChanges(); // Aplica el cambio de tamaño dinámico de la caja del chat
  }

  cerrarConversacion(chat: any, evento: Event) {
    evento.stopPropagation();
    this.chatsAbiertos = this.chatsAbiertos.filter(c => c.nombre !== chat.nombre);
    this.cdr.detectChanges(); // Elimina visualmente la ventana flotante de inmediato
  }

  enviarMensaje(chat: any) {
    if (!chat.nuevoMensajeTexto.trim()) return;

    const textoMensaje = chat.nuevoMensajeTexto;
    chat.nuevoMensajeTexto = ''; 

    // SOLO DISPARAMOS EL WEBSOCKET. EL SERVIDOR HACE EL RESTO.
    this.socketAPI.enviarMensajePrivado(this.miUsuario, chat.nombre, textoMensaje);
    this.cdr.detectChanges(); // Limpia la caja de texto en la pantalla inmediatamente
  }

  cargarHistorial() {
    this.chatAPI.obtenerHistorial().subscribe({
      next: (data) => {
        console.log('📦 HISTORIAL DESDE SQLITE:', data);

        this.mensajes = data.map(m => ({
          ...m,
          texto: m.texto || m.contenido,
          fecha: m.fecha || m.fechaEnvio
        }));
        this.cdr.detectChanges(); // Redibuja todas las burbujas históricas del chat al cargar
      },
      error: (err) => console.error('Error cargando historial de la BD:', err)
    });
  }

  obtenerMensajesDe(contacto: string) {
    if (!contacto || !this.miUsuario) return [];

    const miUsuarioLimpio = this.miUsuario.toLowerCase().trim();
    const contactoLimpio = contacto.toLowerCase().trim();

    return this.mensajes.filter(m => {
      const emisor = (m.emisor || '').toLowerCase().trim();
      const receptor = (m.receptor || '').toLowerCase().trim();

      return (emisor === miUsuarioLimpio && receptor === contactoLimpio) ||
             (emisor === contactoLimpio && receptor === miUsuarioLimpio);
    });
  }

  multiplesRolesDisponibles(): boolean {
    const rolesStr = localStorage.getItem('usuario_roles');
    if (!rolesStr) return false;
    try {
      const roles = JSON.parse(rolesStr);
      return Array.isArray(roles) && roles.length > 1;
    } catch {
      return false;
    }
  }
}