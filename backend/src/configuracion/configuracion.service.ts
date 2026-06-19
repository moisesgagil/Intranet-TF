import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Configuracion } from './entities/configuracion.entity';

@Injectable()
export class ConfiguracionService implements OnModuleInit {
  constructor(
    @InjectRepository(Configuracion, 'intranetConnection')
    private configRepository: Repository<Configuracion>,
  ) {}

  async onModuleInit() {
    // Seed predefinido si no existe
    const exists = await this.configRepository.findOne({ where: { clave: 'allow_server_change' } });
    if (!exists) {
      await this.configRepository.save([
        { clave: 'allow_server_change', valor: 'true' },
        { clave: 'default_server', valor: 'test' },
        { clave: 'lirion_host', valor: '192.168.3.80' },
        { clave: 'lirion_database', valor: 'techfoods09022026' }
      ]);
    }
  }

  async getAll(): Promise<Configuracion[]> {
    return this.configRepository.find();
  }

  async updateBatch(configs: { clave: string; valor: string }[]): Promise<any> {
    const promises = configs.map(c => 
      this.configRepository.save({ clave: c.clave, valor: c.valor })
    );
    await Promise.all(promises);
    return { success: true };
  }
}
