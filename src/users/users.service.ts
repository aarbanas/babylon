import { User } from '@prisma/client';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { FindUserDto } from './dto/find-user.dto';
import { S3Service } from '../storage/s3.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BcryptService } from '../service/bcrypt.service';
import { ICreateStrategy } from './create-strategy/icreate.strategy';
import { UploadProfilePhotoResponse } from './dto/upload-avatar-response.dto';
import { UsersRepository } from './repository/users.repository';
import { extname } from 'path';
import { createHash } from 'crypto';
import axios from 'axios';
import * as process from 'node:process';

@Injectable()
export class UsersService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
    private readonly usersRepository: UsersRepository,
    private readonly bcryptService: BcryptService,
  ) {}

  async create(createUserDto: CreateUserDto, strategy: ICreateStrategy) {
    // Validate ReCaptcha
    const isHuman = await this.validateReCaptcha(createUserDto.reCaptchaToken);
    if (!isHuman) {
      throw new ForbiddenException('You are a robot');
    }

    const password = await this.bcryptService.hashPassword(
      createUserDto.password,
    );

    return strategy.create({ ...createUserDto, password });
  }

  async find(query: FindUserDto, user: User) {
    try {
      const { data: users, meta } = await this.usersRepository.find(
        query,
        user,
      );

      const usersWithProfilePhotos = await Promise.all(
        users.map(async (user) => {
          let profilePhoto: string | null = null;
          if (user.profilePhotoKey) {
            profilePhoto = await this.s3Service.get(user.profilePhotoKey);
          }

          return {
            ...user,
            profilePhoto,
          };
        }),
      );

      return {
        meta,
        data: usersWithProfilePhotos,
      };
    } catch (e) {
      throw new NotFoundException();
    }
  }

  async findOne(id: number) {
    const user = await this.usersRepository.findOne(id);
    const { profilePhotoKey, ...restUser } = user;

    let profilePhoto = '';
    if (profilePhotoKey) {
      profilePhoto = await this.s3Service.get(profilePhotoKey);
    }

    return {
      ...restUser,
      profilePhoto,
    };
  }

  async findByEmail(email: string) {
    try {
      return await this.prismaService.user.findUnique({ where: { email } });
    } catch (e) {
      throw new NotFoundException();
    }
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    try {
      return await this.usersRepository.update(id, updateUserDto);
    } catch (e) {
      throw new NotFoundException();
    }
  }

  async remove(id: number) {
    const user = await this.usersRepository.remove(id);

    if (user?.userAttributes?.certificates?.length) {
      const keys = user.userAttributes.certificates.map(({ key }) => key);
      await this.s3Service.deleteMany(keys);
    }
  }

  async uploadProfilePhoto(
    id: number,
    file: Express.Multer.File,
  ): Promise<UploadProfilePhotoResponse> {
    const fileExt = extname(file.originalname);
    const filename = createHash('md5').update(String(id)).digest('hex');
    const profilePhotoKey = `profile_photos/${filename}${fileExt}`;

    await this.s3Service.upload(file.buffer, profilePhotoKey, {
      mimetype: file.mimetype,
    });

    await this.usersRepository.updateProfilePhoto(id, profilePhotoKey);

    const profilePhoto = await this.s3Service.get(profilePhotoKey);
    return {
      profilePhoto,
    };
  }

  private async validateReCaptcha(token: string): Promise<boolean> {
    const BASE_URL = 'https://www.google.com/recaptcha/api/siteverify';
    const res = await axios.post<{
      success: boolean;
      challenge_ts: string;
      hostname: string;
    }>(
      `${BASE_URL}?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${token}`,
    );

    return res.data.success;
  }
}
