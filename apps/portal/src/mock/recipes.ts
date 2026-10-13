import type { Recipe } from '../api/recipes';
import recipes from './recipes.json';

export const platformRecipes = recipes as Recipe[];
