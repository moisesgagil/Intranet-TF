import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('configuracion')
export class Configuracion {
  @PrimaryColumn({ length: 100 })
  clave!: string;

  @Column('text')
  valor!: string;
}
