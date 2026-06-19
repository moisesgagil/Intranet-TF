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
  updateRole(@Param('id') id: string, @Body('rol') rol: string[]) {
    return this.usuariosService.updateRole(+id, rol);
  }

  @Put(':id/activo')
  updateActivo(@Param('id') id: string, @Body('activo') activo: number) {
    return this.usuariosService.updateActivo(+id, activo);
  }

  @Put(':id/email')
  updateEmail(@Param('id') id: string, @Body('email') email: string) {
    return this.usuariosService.updateEmail(+id, email);
  }
}
