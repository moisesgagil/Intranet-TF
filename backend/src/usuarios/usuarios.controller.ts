import { Controller, Get, Put, Param, Body } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';

@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  findAll() {
    return this.usuariosService.findAll();
  }

  @Put(':id/rol')
  updateRole(@Param('id') id: string, @Body('rol') rol: string) {
    return this.usuariosService.updateRole(+id, rol);
  }
}
