import axios from "axios";
import { Logger } from "./logger";
import type {
  ApiInterface,
  GetApiResponse,
  ProjectInfo,
  CategoryInfo,
  ApiSearchResultItem,
  ApiSearchResponse,
  GetProjectResponse,
  GetCategoryListResponse,
  SaveApiInterfaceParams,
  SaveApiResponse,
  AddCategoryParams,
  UpdateCategoryParams,
  SaveCategoryResponse,
  LoginResponse,
  LoginUserInfo,
  CategorySearchResultItem
} from "./types";

export class YApiService {
  private readonly baseUrl: string;
  private readonly tokenMap: Map<string, string>;
  private readonly defaultToken: string;
  private projectInfoCache: Map<string, ProjectInfo> = new Map(); // 缓存项目信息
  private categoryListCache: Map<string, CategoryInfo[]> = new Map(); // 缓存项目分类列表
  private readonly logger: Logger;

  // 登录态：YApi 的 up_cat / del_cat 只认 Cookie，不认项目 token
  private readonly loginEmail: string;
  private readonly loginPassword: string;
  private cookieHeader: string = "";
  private loginUser: LoginUserInfo | null = null;

  constructor(
    baseUrl: string,
    token: string,
    logLevel: string = "info",
    loginEmail: string = "",
    loginPassword: string = ""
  ) {
    this.baseUrl = baseUrl;
    this.tokenMap = new Map();
    this.defaultToken = "";
    this.loginEmail = loginEmail;
    this.loginPassword = loginPassword;
    this.logger = new Logger('YApiService', logLevel);
    
    // 解析token字符串，格式为: "projectId:token,projectId:token,..."
    if (token) {
      const tokenPairs = token.split(',');
      for (const pair of tokenPairs) {
        const [projectId, projectToken] = pair.trim().split(':');
        if (projectId && projectToken) {
          this.tokenMap.set(projectId, projectToken);
        } else if (!projectId.includes(':')) {
          // 如果没有冒号，则作为默认token
          this.defaultToken = pair.trim();
        }
      }
    }
    
    this.logger.info(`YApiService已初始化，baseUrl=${baseUrl}`);
  }

  /**
   * 获取已配置的项目ID列表
   */
  getConfiguredProjectIds(): string[] {
    return Array.from(this.tokenMap.keys());
  }

  /**
   * 获取项目信息缓存
   */
  getProjectInfoCache(): Map<string, ProjectInfo> {
    return this.projectInfoCache;
  }

  /**
   * 获取项目分类列表缓存
   */
  getCategoryListCache(): Map<string, CategoryInfo[]> {
    return this.categoryListCache;
  }

  /**
   * 根据项目ID获取对应的token
   */
  private getToken(projectId: string): string {
    return this.tokenMap.get(projectId) || this.defaultToken;
  }

  /**
   * 是否配置了登录账号（部分写接口只认登录态 Cookie，不认项目 token）
   */
  hasLoginCredentials(): boolean {
    return Boolean(this.loginEmail && this.loginPassword);
  }

  /**
   * 未配置登录账号时给出的可操作提示
   */
  private getMissingCredentialMessage(): string {
    return (
      "该操作需要 YApi 登录态：YApi 的 up_cat / del_cat 接口只认登录 Cookie，不接受项目 token。" +
      "请在 MCP 配置中提供 YAPI_LOGIN_EMAIL 与 YAPI_LOGIN_PASSWORD（或命令行参数 --yapi-login-email / --yapi-login-password）后重试。"
    );
  }

  /**
   * 确保已登录；force 为 true 时强制重新登录
   */
  private async ensureLogin(force: boolean = false): Promise<void> {
    if (!this.hasLoginCredentials()) {
      throw new Error(this.getMissingCredentialMessage());
    }
    if (!force && this.cookieHeader) {
      return;
    }
    await this.login();
  }

  /**
   * 调用 YApi 登录接口，保存登录 Cookie
   */
  private async login(): Promise<void> {
    this.cookieHeader = "";
    this.loginUser = null;

    try {
      this.logger.debug(`登录 YApi，email=${this.loginEmail}`);
      const response = await axios.post(`${this.baseUrl}/api/user/login`, {
        email: this.loginEmail,
        password: this.loginPassword,
      });

      const data = response.data as LoginResponse;
      if (!data || data.errcode !== 0) {
        throw new Error(`YApi 登录失败: ${data?.errmsg || "YApi 未返回有效响应"}`);
      }

      const rawSetCookie = response.headers["set-cookie"];
      const cookies = Array.isArray(rawSetCookie)
        ? rawSetCookie
        : rawSetCookie
          ? [rawSetCookie]
          : [];
      const cookiePairs = cookies
        .map(cookie => cookie.split(";")[0].trim())
        .filter(cookie => cookie.includes("="));

      if (cookiePairs.length === 0) {
        throw new Error(
          "YApi 登录成功但未返回登录 Cookie，可能被反向代理剥离，无法执行需要登录态的操作"
        );
      }

      this.cookieHeader = cookiePairs.join("; ");
      this.loginUser = data.data;
      this.logger.info(
        `YApi 登录成功，用户: ${data.data?.username || ""}(${data.data?.uid ?? ""})`
      );
    } catch (error) {
      this.cookieHeader = "";
      this.loginUser = null;
      if (axios.isAxiosError(error)) {
        const errmsg = error.response?.data?.errmsg || error.message;
        throw new Error(`YApi 登录失败: ${errmsg}`);
      }
      throw error;
    }
  }

  /**
   * 判断响应是否表示登录态失效
   */
  private isNotLoginResponse(data: any): boolean {
    return Boolean(data) && typeof data === "object" && data.errcode === 40011;
  }

  /**
   * 发送一次 HTTP 请求
   */
  private async sendRequest<T>(
    endpoint: string,
    params: Record<string, any>,
    method: "GET" | "POST",
    projectId: string | undefined,
    useCookie: boolean
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (useCookie && this.cookieHeader) {
      headers["Cookie"] = this.cookieHeader;
    }

    // 登录态请求不带 token，避免 YApi 误走 token 鉴权分支
    const token = useCookie ? "" : projectId ? this.getToken(projectId) : this.defaultToken;
    if (!useCookie && !token) {
      throw new Error(`未配置项目ID ${projectId} 的token`);
    }
    const payload = token ? { ...params, token } : { ...params };

    if (method === "GET") {
      const response = await axios.get(`${this.baseUrl}${endpoint}`, {
        params: payload,
        headers,
      });
      return response.data;
    }

    const response = await axios.post(`${this.baseUrl}${endpoint}`, payload, {
      headers,
    });
    return response.data;
  }

  /**
   * 统一的请求入口
   * @param options.requireLogin 需要登录态 Cookie（如 up_cat / del_cat）
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, any> = {},
    projectId?: string,
    method: "GET" | "POST" = "GET",
    options: { requireLogin?: boolean } = {}
  ): Promise<T> {
    const useCookie = options.requireLogin === true;

    try {
      this.logger.debug(`调用 ${this.baseUrl}${endpoint} 方法: ${method}`);
      await this.ensureLoginIfNeeded(useCookie);

      const data = await this.sendRequest<T>(endpoint, params, method, projectId, useCookie);

      // 登录态过期：自动重新登录并重试一次
      if (useCookie && this.isNotLoginResponse(data) && this.hasLoginCredentials()) {
        this.logger.info(`登录态已失效，重新登录后重试: ${endpoint}`);
        await this.ensureLogin(true);
        return await this.sendRequest<T>(endpoint, params, method, projectId, true);
      }

      return data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        throw {
          status: error.response.status,
          message: (error.response.data as any)?.errmsg || "未知错误",
        };
      }
      throw error;
    }
  }

  /**
   * 仅在需要登录态时确保登录，不影响纯 token 请求
   */
  private async ensureLoginIfNeeded(useCookie: boolean): Promise<void> {
    if (!useCookie) {
      return;
    }
    if (!this.hasLoginCredentials()) {
      throw new Error(this.getMissingCredentialMessage());
    }
    await this.ensureLogin(false);
  }

  /**
   * 获取分类列表
   * @param projectId 项目ID
   */
  async getCategoryList(projectId: string): Promise<CategoryInfo[]> {
    try {
      // 先检查缓存
      if (this.categoryListCache.has(projectId)) {
        return this.categoryListCache.get(projectId)!;
      }
      
      // 缓存中没有，从API获取
      this.logger.debug(`从API获取项目分类列表，projectId=${projectId}`);
      const response = await this.request<GetCategoryListResponse>("/api/interface/getCatMenu", { project_id: projectId }, projectId);
      
      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "获取分类列表失败");
      }
      
      // 保存到缓存
      this.categoryListCache.set(projectId, response.data);
      
      return response.data;
    } catch (error) {
      this.logger.error(`获取项目分类列表失败, projectId=${projectId}:`, error);
      throw error;
    }
  }

  /**
   * 加载所有项目的分类列表
   */
  async loadAllCategoryLists(): Promise<void> {
    // 获取已缓存的项目ID列表
    const projectIds = Array.from(this.projectInfoCache.keys());
    
    if (projectIds.length === 0) {
      this.logger.info('项目信息未加载，无法加载分类列表');
      return;
    }
    
    this.logger.info(`开始加载 ${projectIds.length} 个项目的分类列表...`);
    
    try {
      // 并行加载所有项目的分类列表
      await Promise.all(projectIds.map(id => this.getCategoryList(id)));
      this.logger.info(`已加载 ${this.categoryListCache.size} 个项目的分类列表`);
    } catch (error) {
      this.logger.error('加载项目分类列表失败:', error);
    }
  }

  /**
   * 获取项目信息
   * @param projectId 项目ID
   */
  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    try {
      // 先检查缓存
      if (this.projectInfoCache.has(projectId)) {
        return this.projectInfoCache.get(projectId)!;
      }
      
      // 缓存中没有，从API获取
      this.logger.debug(`从API获取项目信息，projectId=${projectId}`);
      const response = await this.request<GetProjectResponse>("/api/project/get", { id: projectId }, projectId);
      
      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "获取项目信息失败");
      }
      
      // 保存到缓存
      this.projectInfoCache.set(projectId, response.data);
      
      return response.data;
    } catch (error) {
      this.logger.error(`获取项目信息失败, projectId=${projectId}:`, error);
      throw error;
    }
  }

  /**
   * 加载所有已配置项目的信息
   */
  async loadAllProjectInfo(): Promise<void> {
    const projectIds = this.getConfiguredProjectIds();
    
    if (projectIds.length === 0) {
      this.logger.info('未配置项目ID，无法加载项目信息');
      return;
    }
    
    this.logger.info(`开始加载 ${projectIds.length} 个项目的信息...`);
    
    try {
      // 并行加载所有项目的信息
      await Promise.all(projectIds.map(id => this.getProjectInfo(id)));
      this.logger.info(`已加载 ${this.projectInfoCache.size} 个项目的信息`);
    } catch (error) {
      this.logger.error('加载项目信息失败:', error);
    }
  }

  /**
   * 获取接口详情
   * @param projectId 项目ID
   * @param id 接口ID
   */
  async getApiInterface(projectId: string, id: string): Promise<ApiInterface> {
    try {
      this.logger.debug(`获取接口详情，projectId=${projectId}, apiId=${id}`);
      const response = await this.request<GetApiResponse>("/api/interface/get", { id }, projectId);
      
      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "获取接口详情失败");
      }
      
      return response.data;
    } catch (error) {
      this.logger.error(`获取接口详情失败, projectId=${projectId}, apiId=${id}:`, error);
      throw error;
    }
  }

  /**
   * 新增或更新接口
   * @param params 接口参数
   */
  async saveInterface(params: SaveApiInterfaceParams): Promise<SaveApiResponse> {
    try {
      const projectId = params.project_id;
      const isAdd = !params.id;
      
      this.logger.debug(`${isAdd ? '新增' : '更新'}接口, projectId=${projectId}, title=${params.title}`);
      
      // 选择合适的API端点
      const endpoint = isAdd ? "/api/interface/add" : "/api/interface/up";
      
      const response = await this.request<SaveApiResponse>(
        endpoint,
        params,
        projectId,
        'POST'
      );
      
      if (response.errcode !== 0) {
        throw new Error(response.errmsg || `${isAdd ? '新增' : '更新'}接口失败`);
      }
      
      return response;
    } catch (error) {
      this.logger.error(`${params.id ? '更新' : '新增'}接口失败:`, error);
      throw error;
    }
  }

  /**
   * 搜索接口
   */
  async searchApis(options: {
    projectKeyword?: string; // 项目关键字
    nameKeyword?: string[] | string;    // 接口名称关键字，支持数组或字符串
    pathKeyword?: string[] | string;    // 接口路径关键字，支持数组或字符串
    tagKeyword?: string[] | string;     // 接口标签关键字，支持数组或字符串
    page?: number;           // 当前页码，默认1
    limit?: number;          // 每页数量，默认20
    maxProjects?: number;    // 最多搜索多少个项目，默认5个
  }): Promise<{
    total: number;
    list: Array<ApiSearchResultItem & { project_name?: string; cat_name?: string }>;
  }> {
    // 提取查询参数
    const {
      projectKeyword,
      nameKeyword,
      pathKeyword,
      tagKeyword,
      page = 1,
      limit = 20,
      maxProjects = 5
    } = options;
    
    // 转换查询关键字为数组
    const nameKeywords = Array.isArray(nameKeyword) ? nameKeyword : nameKeyword ? [nameKeyword] : [];
    const pathKeywords = Array.isArray(pathKeyword) ? pathKeyword : pathKeyword ? [pathKeyword] : [];
    const tagKeywords = Array.isArray(tagKeyword) ? tagKeyword : tagKeyword ? [tagKeyword] : [];
    
    this.logger.debug(
      `搜索接口 项目关键字: ${projectKeyword || '无'}, ` +
      `接口名称关键字: ${nameKeywords.join(',')} ` +
      `路径关键字: ${pathKeywords.join(',')} ` +
      `标签关键字: ${tagKeywords.join(',')}`
    );
    
    try {
      // 1. 获取所有项目信息（或根据关键字过滤）
      await this.loadAllProjectInfo();
      let projects = Array.from(this.projectInfoCache.values());
      
      // 如果指定了项目关键字，过滤项目列表
      if (projectKeyword && projectKeyword.trim().length > 0) {
        const keyword = projectKeyword.trim().toLowerCase();
        projects = projects.filter(project => 
          project.name.toLowerCase().includes(keyword) || 
          project.desc.toLowerCase().includes(keyword) ||
          String(project._id).includes(keyword)
        );
      }
      
      // 限制只搜索前几个匹配的项目
      if (projects.length > maxProjects) {
        this.logger.info(`符合条件的项目过多，只搜索前 ${maxProjects} 个项目`);
        projects = projects.slice(0, maxProjects);
      }
      
      // 如果没有符合条件的项目，返回空结果
      if (projects.length === 0) {
        this.logger.info('没有找到符合条件的项目');
        return { total: 0, list: [] };
      }
      
      this.logger.info(`在 ${projects.length} 个项目中搜索接口...`);
      
      // 2. 在每个项目中搜索接口
      let allResults: ApiSearchResultItem[] = [];
      for (const project of projects) {
        const projectId = String(project._id);
        
        for (const nameKey of nameKeywords.length ? nameKeywords : [""]) {
          for (const pathKey of pathKeywords.length ? pathKeywords : [""]) {
            for (const tagKey of tagKeywords.length ? tagKeywords : [""]) {
              // 准备查询参数
              const queryParams: Record<string, any> = {};
              if (nameKey) queryParams.keyword = nameKey;
              if (pathKey) queryParams.path = pathKey;
              if (tagKey) queryParams.tag = [tagKey];
              
              // 执行搜索
              const projectResults = await this.searchWithSingleKeyword(
                projectId, 
                queryParams, 
                page, 
                limit
              );
              
              // 添加项目名称和分类名称
              const resultsWithProjectInfo = await Promise.all(
                projectResults.list.map(async (item) => {
                  // 添加项目名称
                  const result = { 
                    ...item, 
                    project_name: project.name 
                  };
                  
                  // 尝试添加分类名称
                  try {
                    const catId = String(item.catid);
                    if (catId) {
                      // 获取项目的分类列表
                      const categories = await this.getCategoryList(projectId);
                      const category = categories.find(cat => String(cat._id) === catId);
                      if (category) {
                        result.cat_name = category.name;
                      }
                    }
                  } catch (error) {
                    // 忽略获取分类名称的错误
                    this.logger.debug(`无法获取分类名称，项目ID=${projectId}, 分类ID=${item.catid}:`, error);
                  }
                  
                  return result;
                })
              );
              
              // 将结果添加到总结果中
              allResults = [...allResults, ...resultsWithProjectInfo];
            }
          }
        }
      }
      
      // 3. 对结果去重
      const deduplicated = this.deduplicateResults(allResults);
      
      // 如果结果太多，截取合适的数量
      const limitedResults = deduplicated.slice(0, limit);
      
      this.logger.info(`共找到 ${deduplicated.length} 个符合条件的接口，显示 ${limitedResults.length} 个`);
      
      return {
        total: deduplicated.length,
        list: limitedResults
      };
    } catch (error) {
      this.logger.error('搜索接口失败:', error);
      throw error;
    }
  }

  /**
   * 使用单个关键字在单个项目中搜索接口
   */
  private async searchWithSingleKeyword(
    projectId: string, 
    queryParams: { keyword?: string; path?: string; tag?: string[] }, 
    page: number, 
    limit: number
  ): Promise<{ total: number; list: any[] }> {
    try {
      // 构建查询参数
      const params = {
        project_id: projectId,
        page,
        limit,
        ...queryParams
      };
      
      const response = await this.request<ApiSearchResponse>("/api/interface/list", params, projectId);
      
      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "搜索接口失败");
      }
      
      return response.data;
    } catch (error) {
      this.logger.debug(`在项目 ${projectId} 中使用关键字 ${JSON.stringify(queryParams)} 搜索接口失败:`, error);
      // 搜索失败时返回空结果，而非抛出异常中断整个搜索流程
      return { total: 0, list: [] };
    }
  }

  /**
   * 对搜索结果去重
   */
  private deduplicateResults(results: any[]): any[] {
    // 使用接口ID作为唯一标识符去重
    const seen = new Set<string>();
    return results.filter(item => {
      const id = String(item._id);
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }

  /**
   * 获取分类下的所有接口（自动翻页，避免分类接口超过一页时漏统计）
   */
  async getCategoryApis(projectId: string, catId: string): Promise<Array<ApiSearchResultItem>> {
    const pageSize = 100;
    const allApis: Array<ApiSearchResultItem> = [];

    try {
      for (let page = 1; page <= 10; page++) {
        const response = await this.request<ApiSearchResponse>(
          "/api/interface/list_cat",
          {
            project_id: projectId,
            catid: catId,
            page,
            limit: pageSize
          },
          projectId
        );

        if (response.errcode !== 0) {
          throw new Error(response.errmsg || "获取分类接口列表失败");
        }

        const list = response.data?.list || [];
        allApis.push(...list);

        // 本页不足一页，或已达到总数，说明取完了
        if (list.length < pageSize || allApis.length >= (response.data?.count || 0)) {
          break;
        }
      }

      return allApis;
    } catch (error) {
      this.logger.error(`获取分类接口列表失败, projectId=${projectId}, catId=${catId}:`, error);
      throw error;
    }
  }

  /**
   * 新增分类
   * add_cat 在 YApi 的 token 白名单内，因此优先用项目 token，无需登录态
   */
  async addCategory(params: AddCategoryParams): Promise<SaveCategoryResponse> {
    const projectId = String(params.project_id);
    try {
      this.logger.debug(`新增分类, projectId=${projectId}, name=${params.name}`);
      const response = await this.request<SaveCategoryResponse>(
        "/api/interface/add_cat",
        {
          project_id: projectId,
          name: params.name,
          desc: params.desc || ""
        },
        projectId,
        "POST"
      );

      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "新增分类失败");
      }

      this.invalidateCategoryCache(projectId);
      return response;
    } catch (error) {
      this.logger.error(`新增分类失败, projectId=${projectId}, name=${params.name}:`, error);
      throw error;
    }
  }

  /**
   * 更新分类
   * YApi 的 up_cat 只接受 catid / name / desc，未传的字段会保持原值
   * @param projectId 可选，传入时只失效该项目的分类缓存
   */
  async updateCategory(params: UpdateCategoryParams, projectId?: string): Promise<SaveCategoryResponse> {
    const catid = String(params.catid);
    try {
      this.logger.debug(`更新分类, catid=${catid}`);
      const response = await this.request<SaveCategoryResponse>(
        "/api/interface/up_cat",
        {
          catid,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.desc !== undefined ? { desc: params.desc } : {})
        },
        undefined,
        "POST",
        { requireLogin: true }
      );

      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "更新分类失败");
      }

      this.invalidateCategoryCache(projectId);
      return response;
    } catch (error) {
      this.logger.error(`更新分类失败, catid=${catid}:`, error);
      throw error;
    }
  }

  /**
   * 删除分类（YApi 会连带删除该分类下的所有接口）
   * @param projectId 可选，传入时只失效该项目的分类缓存
   */
  async deleteCategory(catid: string, projectId?: string): Promise<SaveCategoryResponse> {
    try {
      this.logger.debug(`删除分类, catid=${catid}`);
      const response = await this.request<SaveCategoryResponse>(
        "/api/interface/del_cat",
        { catid },
        undefined,
        "POST",
        { requireLogin: true }
      );

      if (response.errcode !== 0) {
        throw new Error(response.errmsg || "删除分类失败");
      }

      this.invalidateCategoryCache(projectId);
      return response;
    } catch (error) {
      this.logger.error(`删除分类失败, catid=${catid}:`, error);
      throw error;
    }
  }

  /**
   * 搜索分类：按分类名称模糊 + 分类ID包含匹配
   * @param options.projectId 不传则搜索所有已配置项目
   * @param options.keyword 分类名称或分类ID关键字
   */
  async searchCategories(options: {
    projectId?: string;
    keyword?: string;
  } = {}): Promise<{ total: number; list: CategorySearchResultItem[] }> {
    const { projectId, keyword } = options;

    try {
      // 确定要搜索的项目
      let projectIds: string[];
      if (projectId) {
        projectIds = [String(projectId)];
        // 确保项目信息存在，用于返回项目名称
        if (!this.projectInfoCache.has(String(projectId))) {
          try {
            await this.getProjectInfo(String(projectId));
          } catch (error) {
            this.logger.debug(`获取项目信息失败，将使用项目ID代替项目名称: ${projectId}`, error);
          }
        }
      } else {
        await this.loadAllProjectInfo();
        projectIds = Array.from(this.projectInfoCache.keys());
      }

      const normalizedKeyword = keyword?.trim().toLowerCase();
      const results: CategorySearchResultItem[] = [];

      for (const id of projectIds) {
        let categories: CategoryInfo[];
        try {
          categories = await this.getCategoryList(id);
        } catch (error) {
          this.logger.debug(`获取项目 ${id} 的分类列表失败，跳过:`, error);
          continue;
        }

        const projectName = this.projectInfoCache.get(id)?.name || `未知项目(${id})`;

        for (const category of categories) {
          if (normalizedKeyword) {
            const nameMatched = (category.name || "").toLowerCase().includes(normalizedKeyword);
            const idMatched = String(category._id).includes(normalizedKeyword);
            if (!nameMatched && !idMatched) {
              continue;
            }
          }

          results.push({
            projectId: id,
            projectName,
            category
          });
        }
      }

      this.logger.info(
        `分类搜索完成${normalizedKeyword ? `，关键字: ${normalizedKeyword}` : ""}，共 ${results.length} 个分类`
      );

      return { total: results.length, list: results };
    } catch (error) {
      this.logger.error("搜索分类失败:", error);
      throw error;
    }
  }

  /**
   * 失效分类缓存；不传 projectId 时清空全部
   */
  invalidateCategoryCache(projectId?: string): void {
    if (projectId) {
      this.categoryListCache.delete(String(projectId));
      return;
    }
    this.categoryListCache.clear();
  }
}