import { redirect } from "next/navigation";
import sdk, { Query } from "node-appwrite";

import { client, clientAdmin } from "@/config/appwrite-server";
import getUser from "@/utils/github/getUser";
import getRepo from "@/utils/github/getRepo";

export async function POST(request) {
  const data = await request.json();
  console.info(`Rating ${data.rating} for ${data.url} recieved`);

  const sessionId = request.headers.get("sessionId");
  const jwt = request.headers.get("Authorization");
  const appwriteClient = client().setJWT(jwt);
  const account = new sdk.Account(appwriteClient);
  const session = await account.getSession(sessionId);

  // find user on github
  let rating = parseInt(data.rating);
  let username = "";
  try {
    const gitHubUserData = await getUser(session.providerAccessToken);
    username = gitHubUserData.login;
  } catch (e) {
    return redirect("/?alert=error&message=Invalid Session");
  }
  console.info(`User ${username} submitted rating for ${data.url}`);

  // 0. get repo from github api
  const urlClean = data.url.endsWith("/") ? data.url.slice(0, -1) : data.url;
  const repoPath = urlClean.split("github.com/");
  if (repoPath.length !== 2) {
    return Response.json({ success: false, error: "Invalid URL" });
  }
  const repoData = await getRepo(repoPath[1], session.providerAccessToken);
  const githubRepo = {
    name: repoData.name,
    owner: repoData.owner.login,
    description: repoData.description,
    logo: repoData.owner.avatar_url,
    language: repoData.language,
    topics: repoData.topics,
    stars: repoData.stargazers_count,
  };
  console.info(`Repo ${githubRepo.name} found on GitHub`);

  // get app total stats to increment
  const appTotal = (
    await new sdk.Databases(clientAdmin()).listDocuments(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_APP_ID,
      [Query.limit(1)]
    )
  ).documents[0];

  // 1. check if user already rated this repo
  const userRepoRating = await new sdk.Databases(clientAdmin()).listDocuments(
    process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
    process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_RATINGS_ID,
    [Query.equal("url", [urlClean]), Query.equal("username", [username])]
  );

  // 2a. update in ratings collection
  if (userRepoRating.total === 1) {
    console.info(`User ${username} already rated ${urlClean} updating rating`);
    await new sdk.Databases(clientAdmin()).updateDocument(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_RATINGS_ID,
      userRepoRating.documents[0].$id,
      {
        username: username,
        url: urlClean,
        rating: rating,
      }
    );
  } else {
    // 2b. create in ratings collection
    console.info(`User ${username} rating ${urlClean} for the first time`);
    await new sdk.Databases(clientAdmin()).createDocument(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_RATINGS_ID,
      sdk.ID.unique(),
      {
        username: username,
        url: urlClean,
        rating: rating,
      }
    );
  }

  // 2c. update app rating count
  console.info("Increment app total ratings");
  await new sdk.Databases(clientAdmin()).updateDocument(
    process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
    process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_APP_ID,
    appTotal.$id,
    {
      ratings: appTotal.ratings + 1,
      stars: appTotal.stars + rating,
    }
  );

  // 3. check if repo exists
  console.info(`Checking if repo ${urlClean} exists in database`);
  const repos = await new sdk.Databases(clientAdmin()).listDocuments(
    process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
    process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_REPOS_ID,
    [Query.equal("url", [urlClean])]
  );

  // 4a. update in repos collection + calculate new rating
  if (repos.total === 1) {
    console.info(`Repo ${urlClean} found in database update rating`);
    // get all ratings for this repo
    const ratings = await new sdk.Databases(clientAdmin()).listDocuments(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_RATINGS_ID,
      [Query.equal("url", [urlClean])]
    );

    // save new repo rating
    const averageRating =
      ratings.documents.reduce((acc, cur) => acc + cur.rating, 0) /
      ratings.total;
    await new sdk.Databases(clientAdmin()).updateDocument(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_REPOS_ID,
      repos.documents[0].$id,
      {
        ...githubRepo,
        rating: averageRating,
        votes: ratings.total,
      }
    );
  } else {
    // 4a. create in repos collection
    console.info(
      `Repo ${urlClean} not found in database create repo and ratings`
    );
    await new sdk.Databases(clientAdmin()).createDocument(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_REPOS_ID,
      sdk.ID.unique(),
      {
        ...githubRepo,
        url: urlClean,
        rating: rating,
        votes: 1,
      }
    );
    // 4b. update app repo count
    console.info("Increment app total repos");
    await new sdk.Databases(clientAdmin()).updateDocument(
      process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID,
      process.env.NEXT_PUBLIC_APPWRITE_COLLECTION_APP_ID,
      appTotal.$id,
      {
        repos: appTotal.repos + 1,
      }
    );
  }

  return Response.json({ success: true, data: githubRepo });
}
