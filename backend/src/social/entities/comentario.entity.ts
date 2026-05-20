import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { Noticia } from './noticia.entity';

@Entity('comentarios')
export class Comentario {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  autor!: string;

  @Column('text')
  contenido!: string;

  // Relación: Muchos comentarios pertenecen a UNA noticia.
  @ManyToOne(() => Noticia, (noticia) => noticia.comentarios, { onDelete: 'CASCADE' })
  noticia!: Noticia;

  @CreateDateColumn()
  fechaCreacion!: Date;
}