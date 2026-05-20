import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Noticia } from './entities/noticia.entity';
import { Reaccion } from './entities/reaccion.entity';
import { Comentario } from './entities/comentario.entity';

@Injectable()
export class SocialService {
  constructor(
    @InjectRepository(Noticia, 'intranetConnection')
    private noticiaRepository: Repository<Noticia>,
    
    @InjectRepository(Reaccion, 'intranetConnection')
    private reaccionRepository: Repository<Reaccion>,

    @InjectRepository(Comentario, 'intranetConnection')
    private comentarioRepository: Repository<Comentario>,
  ) {}

  async obtenerNoticias(): Promise<Noticia[]> {
    // 1. FILTRADO: Agregamos el parámetro 'where' para cargar solo las noticias vigentes
    return this.noticiaRepository.find({ 
      where: { activo: true }, 
      order: { fechaCreacion: 'DESC' },
      relations: ['reacciones', 'comentarios'] 
    });
  }

  async crearNoticia(datosNoticia: Partial<Noticia>): Promise<Noticia> {
    const nuevaNoticia = this.noticiaRepository.create(datosNoticia);
    return this.noticiaRepository.save(nuevaNoticia);
  }

  // Manejo de "Like" y "Unlike" protegido contra duplicados
  async reaccionar(idNoticia: number, tipo: string, autor: string): Promise<any> {
    const noticia = await this.noticiaRepository.findOne({ where: { id: idNoticia } });
    if (!noticia) throw new NotFoundException('La noticia no existe');

    // 1. SI LA ORDEN ES QUITAR EL LIKE: Borramos de la BD
    if (tipo === 'quitar_me_gusta') {
      await this.reaccionRepository.delete({ 
        noticia: { id: idNoticia }, 
        autor: autor 
      });
      return { status: 'eliminado' };
    }

    // 2. SI LA ORDEN ES DAR LIKE: Primero verificamos que no exista para no duplicar jamás
    const existe = await this.reaccionRepository.findOne({
      where: { 
        noticia: { id: idNoticia }, 
        autor: autor 
      }
    });

    if (existe) {
      return existe; 
    }

    // 3. SI NO EXISTÍA: Lo creamos y guardamos
    const nuevaReaccion = this.reaccionRepository.create({ tipo, autor, noticia });
    return this.reaccionRepository.save(nuevaReaccion);
  }

  async comentar(idNoticia: number, autor: string, contenido: string): Promise<Comentario> {
    const noticia = await this.noticiaRepository.findOne({ where: { id: idNoticia } });
    if (!noticia) throw new NotFoundException('La noticia no existe');

    const nuevoComentario = this.comentarioRepository.create({ autor, contenido, noticia });
    return this.comentarioRepository.save(nuevoComentario);
  }

  // =======================================================================
  // ⚙️ NUEVA FUNCIÓN: BAJA LÓGICA (SOFT DELETE)
  // =======================================================================
  async desactivarNoticia(idNoticia: number): Promise<void> {
    const noticia = await this.noticiaRepository.findOne({ where: { id: idNoticia } });
    if (!noticia) throw new NotFoundException('La noticia no existe');
    
    // Cambiamos el switch a inactivo en vez de remover la fila física de SQLite
    noticia.activo = false;
    await this.noticiaRepository.save(noticia);
  }

  // =======================================================================
  // ⚙️ FUNCIÓN DE EDICIÓN
  // =======================================================================
  async editarNoticia(idNoticia: number, titulo: string, contenido: string): Promise<Noticia> {
    const noticia = await this.noticiaRepository.findOne({ where: { id: idNoticia } });
    if (!noticia) throw new NotFoundException('La noticia no existe');
    
    noticia.titulo = titulo;
    noticia.contenido = contenido;
    return await this.noticiaRepository.save(noticia);
  }
}