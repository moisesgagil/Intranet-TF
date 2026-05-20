import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mensaje } from './entities/mensaje.entity';

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(Mensaje, 'intranetConnection')
    private mensajeRepository: Repository<Mensaje>,
  ) {}

  // A diferencia de las noticias, el chat suele ordenarse del más antiguo al más nuevo (ASC)
  async obtenerMensajesHistorial(): Promise<Mensaje[]> {
    return this.mensajeRepository.find({ order: { fechaEnvio: 'ASC' } });
  }

  async guardarMensaje(datosMensaje: Partial<Mensaje>): Promise<Mensaje> {
    const nuevoMensaje = this.mensajeRepository.create(datosMensaje);
    return this.mensajeRepository.save(nuevoMensaje);
  }
}