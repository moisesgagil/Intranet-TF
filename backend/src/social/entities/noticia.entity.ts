import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Reaccion } from './reaccion.entity';
import { Comentario } from './comentario.entity';

@Entity('noticias')
export class Noticia {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  titulo!: string;

  // 🆕 AGREGAMOS ESTA COLUMNA OBLIGATORIA PARA LA BAJA LÓGICA
  @Column({ default: true })
  activo!: boolean;

  @Column('text')
  contenido!: string;

  @Column()
  autor!: string;

  @OneToMany(() => Reaccion, (reaccion) => reaccion.noticia)
  reacciones!: Reaccion[];

  // <-- RELACIÓN PARA LOS COMENTARIOS -->
  @OneToMany(() => Comentario, (comentario) => comentario.noticia)
  comentarios!: Comentario[];

  @CreateDateColumn()
  fechaCreacion!: Date;
}