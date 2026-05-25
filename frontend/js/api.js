/**
 * ClawBot AI - API 请求工具
 * 自动检测当前环境（开发/生产），使用正确的 API 地址
 */

(function() {
  // 获取当前域名，确定 API 地址
  const currentHost = window.location.hostname;
  const currentProtocol = window.location.protocol;
  
  // 开发环境：使用相对路径或本地 Worker
  // 生产环境：使用 Cloudflare 分配的域名
  let API_BASE_URL;
  
  // 如果是 Cloudflare Pages 域名或 localhost
  let API_BASE_URL = 'https://3f76e9cd.bot-7fs.pages.dev';
  
  /**
   * 通用 API 请求函数
   */
  async function request(method, endpoint, data = null) {
    const url = API_BASE_URL + endpoint;
    const token = localStorage.getItem('token');
    
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    // 添加认证 Token
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    // 添加请求体
    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }
    
    try {
      const response = await fetch(url, options);
      const result = await response.json();
      
      // 处理未授权
      if (response.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
        throw new Error('登录已过期，请重新登录');
      }
      
      return result;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }
  
  /**
   * 管理员 API 请求函数
   */
  async function adminRequest(method, endpoint, data = null) {
    const url = API_BASE_URL + endpoint;
    const token = localStorage.getItem('adminToken');
    
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }
    
    try {
      const response = await fetch(url, options);
      const result = await response.json();
      
      if (response.status === 401) {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('admin');
        window.location.href = '/admin/login';
        throw new Error('登录已过期，请重新登录');
      }
      
      return result;
    } catch (error) {
      console.error('Admin API request failed:', error);
      throw error;
    }
  }
  
  // 导出 API 对象
  window.api = {
    get: (endpoint) => request('GET', endpoint),
    post: (endpoint, data) => request('POST', endpoint, data),
    put: (endpoint, data) => request('PUT', endpoint, data),
    delete: (endpoint) => request('DELETE', endpoint)
  };
  
  // 导出管理员 API 对象
  window.adminApi = {
    get: (endpoint) => adminRequest('GET', endpoint),
    post: (endpoint, data) => adminRequest('POST', endpoint, data),
    put: (endpoint, data) => adminRequest('PUT', endpoint, data),
    delete: (endpoint) => adminRequest('DELETE', endpoint)
  };
  
  // 输出配置信息（调试用）
  console.log('ClawBot API initialized, base URL:', API_BASE_URL || '(relative path)');
})();
