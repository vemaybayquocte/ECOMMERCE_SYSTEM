import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ id: string; email: string; roles: string[] }> {
    const existing = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = await this.userRepository.save(
      this.userRepository.create({
        email: dto.email,
        passwordHash,
        roles: ['customer'],
      }),
    );

    return { id: user.id, email: user.email, roles: user.roles };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
    return { accessToken };
  }

  async me(
    userId: string,
  ): Promise<{ id: string; email: string; roles: string[]; createdAt: Date }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      createdAt: user.createdAt,
    };
  }
}
