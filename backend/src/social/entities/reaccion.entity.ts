import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { Noticia } from './noticia.entity';

@Entity('reacciones')
export class Reaccion {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  tipo!: string; // Guardaremos un string como 'like', 'me_encanta', 'celebracion'

  @Column()
  autor!: string; // Quién reaccionó (luego lo cruzaremos con los usuarios de Lirion)

  // Relación: Muchas reacciones pertenecen a UNA noticia.
  // onDelete: 'CASCADE' significa que si borramos la noticia, se borran sus reacciones.
  @ManyToOne(() => Noticia, (noticia) => noticia.reacciones, { onDelete: 'CASCADE' })
  noticia!: Noticia;

  @CreateDateColumn()
  fechaCreacion!: Date;
}