import { Controller, Get, Post, Body } from '@nestjs/common';
import { ConfiguracionService } from './configuracion.service';

@Controller('configuracion')
export class ConfiguracionController {
  constructor(private readonly configuracionService: ConfiguracionService) {}

  @Get()
  getAll() {
    return this.configuracionService.getAll();
  }

  @Post('batch')
  updateBatch(@Body() configs: { clave: string; valor: string }[]) {
    return this.configuracionService.updateBatch(configs);
  }
}
