import { Component, OnInit, inject, ChangeDetectorRef, HostListener } from '@angular/core'; // <-- Importamos HostListener
import { DatePipe, CommonModule } from '@angular/common'; 
import { FormsModule } from '@angular/forms';
import { Social } from '../../services/social';

@Component({
  selector: 'app-inicio',
  standalone: true,
  imports: [DatePipe, FormsModule, CommonModule], 
  templateUrl: './inicio.html'
})
export class Inicio implements OnInit {
  private socialAPI = inject(Social);
  private cdr = inject(ChangeDetectorRef);
  
  miUsuarioReal = localStorage.getItem('usuarioNombre') || 'Nelson';

  noticias: any[] = [];
  nuevaNoticia = { titulo: '', contenido: '', autor: this.miUsuarioReal };

  publicandoNoticia = false;
  publicandoComentarioId: number | null = null;
  cargandoLikeId: number | null = null;

  // 🎛️ CONTROL DEL MENÚ DE 3 PUNTITOS
  menuPostAbiertoId: number | null = null;

  // Escucha clics en toda la pantalla para cerrar el menú si pinchas afuera
  @HostListener('document:click')
  clicGlobal() {
    if (this.menuPostAbiertoId !== null) {
      this.menuPostAbiertoId = null;
      this.cdr.detectChanges();
    }
  }

  ngOnInit() {
    this.cargarNoticias();
  }

  cargarNoticias() {
    this.socialAPI.obtenerNoticias().subscribe({
      next: (data) => {
        this.noticias = data;
        this.cdr.detectChanges(); 
      },
      error: (err) => console.error('Error cargando el feed', err)
    });
  }

  publicar() {
    if (!this.nuevaNoticia.titulo || !this.nuevaNoticia.contenido || this.publicandoNoticia) return;

    this.publicandoNoticia = true; 
    this.nuevaNoticia.autor = this.miUsuarioReal;

    this.socialAPI.crearNoticia(this.nuevaNoticia).subscribe({
      next: () => {
        this.nuevaNoticia.titulo = '';
        this.nuevaNoticia.contenido = '';
        this.cargarNoticias();
        this.publicandoNoticia = false; 
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error al publicar', err);
        this.publicandoNoticia = false; 
        this.cdr.detectChanges();
      }
    });
  }

  darMeGusta(noticia: any) {
    if (this.cargandoLikeId === noticia.id) return;
    this.cargandoLikeId = noticia.id; 

    if (!noticia.reacciones) noticia.reacciones = [];

    const yaTieneLike = noticia.reacciones.some(
      (r: any) => r.autor.toLowerCase().trim() === this.miUsuarioReal.toLowerCase().trim() && r.tipo === 'me_gusta'
    );

    if (yaTieneLike) {
      this.socialAPI.reaccionar(noticia.id, 'quitar_me_gusta', this.miUsuarioReal).subscribe({
        next: () => {
          noticia.reacciones = noticia.reacciones.filter(
            (r: any) => r.autor.toLowerCase().trim() !== this.miUsuarioReal.toLowerCase().trim()
          );
          this.cargandoLikeId = null; 
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error al quitar me gusta', err);
          this.cargandoLikeId = null; 
          this.cdr.detectChanges();
        }
      });
    } else {
      this.socialAPI.reaccionar(noticia.id, 'me_gusta', this.miUsuarioReal).subscribe({
        next: (nuevaReaccion) => {
          noticia.reacciones.push(nuevaReaccion);
          this.cargandoLikeId = null; 
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error al dar me gusta', err);
          this.cargandoLikeId = null; 
          this.cdr.detectChanges();
        }
      });
    }
  }

  usuarioYaDioLike(noticia: any): boolean {
    if (!noticia || !noticia.reacciones) return false;
    return noticia.reacciones.some(
      (r: any) => r.autor.toLowerCase().trim() === this.miUsuarioReal.toLowerCase().trim() && r.tipo === 'me_gusta'
    );
  }

  toggleComentarios(noticia: any) {
    noticia.mostrarComentarios = !noticia.mostrarComentarios;
    this.cdr.detectChanges();
  }

  enviarComentario(noticia: any) {
    if (!noticia.nuevoComentarioTexto || noticia.nuevoComentarioTexto.trim() === '' || this.publicandoComentarioId === noticia.id) return;
    this.publicandoComentarioId = noticia.id; 

    this.socialAPI.comentar(noticia.id, this.miUsuarioReal, noticia.nuevoComentarioTexto).subscribe({
      next: (nuevoComentario) => {
        if (!noticia.comentarios) noticia.comentarios = [];
        noticia.comentarios.push(nuevoComentario);
        noticia.nuevoComentarioTexto = ''; 
        this.publicandoComentarioId = null; 
        this.cdr.detectChanges(); 
      },
      error: (err) => {
        console.error('Error al comentar', err);
        this.publicandoComentarioId = null; 
        this.cdr.detectChanges();
      }
    });
  }

  // =======================================================================
  // ⚙️ NUEVAS FUNCIONES PARA EL MENÚ DE 3 PUNTITOS
  // =======================================================================
  
  // Abre o cierra el menú de una publicación específica
  toggleMenuPost(id: number, evento: Event) {
    evento.stopPropagation(); // Evita que el clic cierre el menú inmediatamente
    this.menuPostAbiertoId = this.menuPostAbiertoId === id ? null : id;
    this.cdr.detectChanges();
  }

  // Comprueba de forma segura si la publicación es del usuario logueado
  esMiPublicacion(autor: string): boolean {
    if (!autor) return false;
    return autor.toLowerCase().trim() === this.miUsuarioReal.toLowerCase().trim();
  }

  borrarNoticia(id: number) {
    this.menuPostAbiertoId = null; // Cierra el menú de 3 puntitos
    
    // Alerta de confirmación nativa para evitar clics accidentales
    if (confirm('¿Estás seguro de que quieres eliminar esta publicación de la intranet?')) {
      this.socialAPI.borrarNoticia(id).subscribe({
        next: () => {
          // Si el servidor confirma, la sacamos del arreglo visual inmediatamente
          this.noticias = this.noticias.filter(n => n.id !== id);
          this.cdr.detectChanges(); // Despierta a Angular para que actualice la vista al tiro
        },
        error: (err) => console.error('Error al intentar borrar la noticia', err)
      });
    }
  }

  reportarNoticia(id: number) {
    this.menuPostAbiertoId = null; 
    console.log('🚩 Preparando para reportar la noticia ID:', id);
  }

  // =======================================================================
  // ✏️ LÓGICA DE EDICIÓN EN LÍNEA
  // =======================================================================
  editarNoticia(noticia: any) {
    this.menuPostAbiertoId = null; // Cierra el menú de los 3 puntitos
    noticia.editando = true; // Activa el modo edición en el HTML
    
    // Guardamos un respaldo de los textos por si el usuario presiona "Cancelar"
    noticia.tituloEdit = noticia.titulo;
    noticia.contenidoEdit = noticia.contenido;
    this.cdr.detectChanges();
  }

  cancelarEdicion(noticia: any) {
    noticia.editando = false;
    this.cdr.detectChanges();
  }

  guardarEdicion(noticia: any) {
    if (!noticia.tituloEdit.trim() || !noticia.contenidoEdit.trim()) return;

    this.socialAPI.editarNoticia(noticia.id, noticia.tituloEdit, noticia.contenidoEdit).subscribe({
      next: () => {
        // Actualizamos la vista con los textos nuevos y salimos del modo edición
        noticia.titulo = noticia.tituloEdit;
        noticia.contenido = noticia.contenidoEdit;
        noticia.editando = false;
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Error al intentar editar', err)
    });
  }

  
}