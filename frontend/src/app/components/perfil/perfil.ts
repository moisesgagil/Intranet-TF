import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-perfil',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './perfil.html'
})
export class Perfil implements OnInit {
  // Rescatamos el nombre real
  miUsuarioReal = localStorage.getItem('usuarioNombre') || 'Nelson';
  
  // Por defecto, Poka prioriza las habilidades y el entrenamiento
  pestanaActiva = 'habilidades'; 

  // Datos simulados del trabajador (luego los traeremos del backend)
  usuario = {
    nombre: this.miUsuarioReal,
    cargo: 'Especialista en Línea de Producción',
    departamento: 'Área de Empaque Termoencogible',
    planta: 'Planta Central',
    nivel: 4,
    puntos: 1250
  };

  // Matriz de competencias tipo Poka
  habilidades = [
    { nombre: 'Normas de Inocuidad (HACCP)', progreso: 100, estado: 'Certificado', color: 'bg-emerald-500' },
    { nombre: 'Operación de Selladora al Vacío', progreso: 100, estado: 'Certificado', color: 'bg-emerald-500' },
    { nombre: 'Mantenimiento Autónomo (TPM)', progreso: 65, estado: 'En capacitación', color: 'bg-amber-500' },
    { nombre: 'Prevención de Riesgos', progreso: 100, estado: 'Certificado', color: 'bg-emerald-500' },
    { nombre: 'Calibración de Etiquetadora', progreso: 20, estado: 'Iniciado', color: 'bg-blue-500' }
  ];

  // Gamificación industrial
  insignias = [
    { icono: '🏆', titulo: 'Resolutor de Problemas', descripcion: 'Has solucionado 10 problemas técnicos en la línea.' },
    { icono: '🛡️', titulo: 'Cero Accidentes', descripcion: 'Completaste 1 año sin incidentes de seguridad.' },
    { icono: '⭐', titulo: 'Entrenador Maestro', descripcion: 'Has capacitado a 3 compañeros nuevos.' }
  ];

  ngOnInit() {
    // Aquí a futuro haremos this.perfilAPI.obtenerMisDatos()...
  }

  cambiarPestana(pestana: string) {
    this.pestanaActiva = pestana;
  }
}