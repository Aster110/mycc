export interface User {
  id: number;
  phone?: string;
  email?: string;
  nickname?: string;
  linux_user: string;
  plan: 'free' | 'basic' | 'pro';
}

export interface LoginRequest {
  credential: string;
  password: string;
}

export interface RegisterRequest {
  phone?: string;
  email?: string;
  password: string;
  nickname?: string;
}

export interface AuthResponse {
  success: boolean;
  data?: {
    token: string;
    user: User;
  };
  error?: string;
}
