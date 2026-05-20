import { Controller, Get, Post, Patch, Body, Param, Delete } from '@nestjs/common'; // <-- Agrega Delete aquí
import { SocialService } from './social.service';
import { Noticia } from './entities/noticia.entity';

@Controller('api/noticias')
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  @Get()
  obtenerTodas() {
    return this.socialService.obtenerNoticias();
  }

  @Post()
  crear(@Body() body: Partial<Noticia>) {
    return this.socialService.crearNoticia(body);
  }

  @Post(':id/reacciones')
  reaccionar(@Param('id') id: number, @Body() body: { tipo: string; autor: string }) {
    return this.socialService.reaccionar(id, body.tipo, body.autor);
  }

  @Post(':id/comentarios')
  comentar(@Param('id') id: number, @Body() body: { autor: string; contenido: string }) {
    return this.socialService.comentar(id, body.autor, body.contenido);
  }

  // 🔥 NUEVA RUTA PARA RECIBIR LA ORDEN DE BORRADO
  @Delete(':id')
  desactivar(@Param('id') id: number) {
    return this.socialService.desactivarNoticia(id);
  }

  // RUTA PARA EDITAR (Se usa Patch porque es una actualización parcial)
  @Patch(':id')
  editar(@Param('id') id: number, @Body() body: { titulo: string; contenido: string }) {
    return this.socialService.editarNoticia(id, body.titulo, body.contenido);
  }
}